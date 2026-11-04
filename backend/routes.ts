import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { db, type SessionContext } from '../database';
import { authenticate, generateToken, requireRole, AuthenticatedRequest } from './auth';
import { accountLast4, clientIp, newId, sessionContextFor, tokenizeBankAccount } from './security';
import { drivingRoute, formatPlaceLabel, reversePlace, searchPlaces, type GeoPlace, type GeoRoute } from './geo';
import { cardFromRow, loadRateCatalog, quoteFor } from './rates';
import { EQUIPMENT_KEYS } from '../database/quote';

export const apiRouter = Router();

/** Lets code inside a transaction or a middleware abort with a specific status. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

// Uploaded documents are served back over HTTP, so the filename, the extension,
// and the content type are all attacker-controlled unless we constrain them.
const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf'
};

// Held in memory only long enough to write to Postgres; the container disk is
// ephemeral, so files cannot live there.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_UPLOAD_TYPES[file.mimetype]) {
      cb(new HttpError(415, `Unsupported file type: ${file.mimetype}. Allowed: PNG, JPEG, WebP, PDF.`));
      return;
    }
    cb(null, true);
  }
});

// Freight photos: images only, and the app shrinks them in the browser first,
// so a limit well under the document one still takes a phone photo.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      cb(new HttpError(415, 'Photos must be JPEG, PNG or WebP.'));
      return;
    }
    cb(null, true);
  }
});

/** The real image type from the file's first bytes; the declared one is the client's word. */
function sniffImageType(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Real-time SSE subscriber connections
const sseClients: Response[] = [];

export function broadcastSettlementEvent(data: any) {
  const payload = `data: ${JSON.stringify({ type: 'settlement_created', data })}\n\n`;
  sseClients.forEach(client => client.write(payload));
}

/**
 * Database handle scoped to the caller's verified identity. Row-Level Security
 * policies decide what these statements may touch, so a mistake in a route
 * cannot reach another user's rows.
 */
function scoped(req: AuthenticatedRequest, override?: Partial<SessionContext>) {
  return db.as({ ...sessionContextFor(req), ...override });
}

/** Pre-authentication contexts: no identity exists yet, so scope is minimal. */
const AUTH_CONTEXT: SessionContext = { role: 'auth' };
const ENROLLMENT_CONTEXT: SessionContext = { role: 'enrollment' };

const ANALYTICS_PATHS = new Set([
  '/',
  '/loads',
  '/books',
  '/drive',
  '/post-load',
  '/privacy',
  '/terms'
]);

async function hitRateLimit(bucket: string, limit: number, windowSecs: number) {
  const limitRes = await db.as({ role: 'anon' }).query<{
    allowed: boolean;
    remaining: number;
    retry_after: number;
  }>('SELECT allowed, remaining, retry_after FROM app_rate_limit_hit($1, $2, $3)', [
    bucket,
    limit,
    windowSecs
  ]);
  return limitRes.rows[0];
}

function sendError(res: Response, err: any): void {
  // A schema rejection means the client sent something wrong, so it must not be
  // reported as a server fault.
  const status = err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500;
  if (status >= 500) console.error('[API] Unhandled error:', err);
  res.status(status).json({ error: err.message });
}

// -------------------------------------------------------------
// 1. CONFIG ENDPOINT - Authoritative Single Source of Truth for Fees
// -------------------------------------------------------------
apiRouter.post('/analytics/page', async (req, res) => {
  const parsed = z.object({ path: z.string().max(80) }).safeParse(req.body);
  if (!parsed.success || !ANALYTICS_PATHS.has(parsed.data.path)) {
    res.status(204).end();
    return;
  }
  try {
    const limit = await hitRateLimit(`analytics:${clientIp(req)}`, 30, 60);
    if (limit && !limit.allowed) {
      res.status(204).end();
      return;
    }
    console.log(`[ANALYTICS] ${parsed.data.path}`);
  } catch (err) {
    console.error('[ANALYTICS] page count failed');
  }
  res.status(204).end();
});

apiRouter.get('/config', async (req, res) => {
  try {
    const rows = await db.as({ role: 'anon' }).query<{ key: string; value: string }>('SELECT key, value FROM platform_config');
    const configMap: Record<string, number> = {};
    rows.rows.forEach(r => {
      configMap[r.key] = parseFloat(r.value);
    });

    res.json({
      fee_pct: configMap['fee_pct'] ?? 0.07,
      factor_pct: configMap['factor_pct'] ?? 0.03,
      broker_comparison_pct: configMap['broker_comparison_pct'] ?? 0.20,
      quote_gross_pct: configMap['quote_gross_pct'] ?? 0.07
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const equipmentKeySchema = z.enum(EQUIPMENT_KEYS);

apiRouter.get('/rates', async (_req, res) => {
  try {
    const catalog = await loadRateCatalog(db.as({ role: 'anon' }));
    res.json(catalog);
  } catch (err: any) {
    sendError(res, err);
  }
});

const quotePreviewSchema = z.object({
  equipment_key: equipmentKeySchema,
  miles: z.coerce.number().positive(),
  deadhead_miles: z.coerce.number().min(0).optional().default(0),
  demand_multiplier: z.coerce.number().positive().max(5).optional(),
  express: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform(v => v === 'true' || v === '1'),
  accessorials: z.string().optional()
});

apiRouter.get('/quotes/preview', async (req, res) => {
  try {
    const q = quotePreviewSchema.parse(req.query);
    const codes = (q.accessorials ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const { quote } = await quoteFor(db.as({ role: 'anon' }), {
      equipment_key: q.equipment_key,
      miles: q.miles,
      deadhead_miles: q.deadhead_miles,
      demand_multiplier: q.demand_multiplier,
      express: q.express,
      accessorial_codes: codes
    });
    res.json({ quote });
  } catch (err: any) {
    sendError(res, err);
  }
});

// -------------------------------------------------------------
// 1b. GEO — US address / street / ZIP / city search, reverse, miles
// -------------------------------------------------------------
const geoSearchSchema = z.object({
  q: z.string().trim().min(2).max(160)
});

const geoCoordSchema = z.object({
  lat: z.coerce.number().gte(18).lte(72),
  lng: z.coerce.number().gte(-180).lte(-66)
});

apiRouter.get('/geo/search', async (req, res) => {
  try {
    const { q } = geoSearchSchema.parse(req.query);
    const results = await searchPlaces(q);
    res.json({ results });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Enter an address, street, city, or ZIP.' });
      return;
    }
    res.status(502).json({ error: err.message || 'Place lookup failed' });
  }
});

apiRouter.get('/geo/reverse', async (req, res) => {
  try {
    const { lat, lng } = geoCoordSchema.parse(req.query);
    const place = await reversePlace(lat, lng);
    if (!place) {
      res.status(404).json({ error: 'Drop the pin on a US address or city.' });
      return;
    }
    res.json({ place });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid map coordinates.' });
      return;
    }
    res.status(502).json({ error: err.message || 'Reverse geocode failed' });
  }
});

apiRouter.get('/geo/route', async (req, res) => {
  try {
    const from = geoCoordSchema.parse({ lat: req.query.fromLat, lng: req.query.fromLng });
    const to = geoCoordSchema.parse({ lat: req.query.toLat, lng: req.query.toLng });
    const route = await drivingRoute(from, to);
    res.json(route);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Need two US points to measure the lane.' });
      return;
    }
    res.status(502).json({ error: err.message || 'Route lookup failed' });
  }
});

// -------------------------------------------------------------
// 2. AUTH ENDPOINTS
// -------------------------------------------------------------
// Public signup mints carrier and shipper accounts only.
//
// 'admin' is deliberately absent: this endpoint is unauthenticated, so
// accepting the role here would let anyone who can reach it grant themselves
// the ledger, every carrier identity, and the RLS bypass behind
// `app_is_admin()`. Administrators are provisioned out of band (seeding, or a
// direct write by an operator), and migration 0012 enforces the same rule at
// the database so a future edit to this enum cannot quietly reopen it.
const signupSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(6, 'Password must be at least 6 characters.'),
  role: z.enum(['driver', 'shipper']),
  phone: z.string().optional(),
  name: z.string().min(2, 'Enter at least 2 characters.'),
  home_city: z.string().optional(),
  home_state: z.string().optional(),
  company_name: z.string().optional(),
  // Honeypot. Real browsers leave it empty; filled posts are rejected.
  website: z.string().max(200).optional()
});

apiRouter.post('/auth/signup', async (req, res) => {
  try {
    const body = signupSchema.parse(req.body);
    if (body.website && body.website.trim().length > 0) {
      return res.status(400).json({ error: 'Could not create that account.' });
    }

    const ip = clientIp(req);
    const limit = await hitRateLimit(`signup:${ip}`, 5, 3600);
    if (limit && !limit.allowed) {
      res.setHeader('Retry-After', String(limit.retry_after || 3600));
      return res.status(429).json({
        error: 'Too many signups from this network. Try again in an hour.',
        retry_after_seconds: limit.retry_after
      });
    }
    const passwordHash = await bcrypt.hash(body.password, 10);

    // User row and its role profile are created together or not at all — a
    // half-created account would leave the user unable to sign up or sign in.
    const { userId, driverId, shipperId } = await db.transaction(async tx => {
      const existing = await tx.query('SELECT id FROM users WHERE email = $1', [body.email]);
      if (existing.rows.length > 0) {
        throw new HttpError(400, 'User with this email already exists');
      }

      const userId = newId('usr');

      await tx.query(
        'INSERT INTO users (id, role, email, phone, password_hash) VALUES ($1, $2, $3, $4, $5)',
        [userId, body.role, body.email, body.phone || null, passwordHash]
      );

      let driverId: string | undefined;
      let shipperId: string | undefined;

      if (body.role === 'driver') {
        driverId = newId('drv');
        await tx.query(`
          INSERT INTO driver_profiles (id, user_id, full_name, home_base_city, home_base_state, verification_status)
          VALUES ($1, $2, $3, $4, $5, 'pending')
        `, [driverId, userId, body.name, body.home_city || 'Dallas', body.home_state || 'TX']);

        await tx.query(`
          INSERT INTO driver_equipment (id, driver_id, equipment_type, trailer_length_ft)
          VALUES ($1, $2, 'dry_van', 53)
        `, ['eq-' + driverId, driverId]);

        await tx.query(`
          INSERT INTO driver_payment_accounts (id, driver_id, payment_processor, processor_account_id, same_day_funding_opt_in)
          VALUES ($1, $2, 'stripe_connect', $3, TRUE)
        `, ['pay-' + driverId, driverId, tokenizeBankAccount(driverId, newId('pending'))]);
      } else if (body.role === 'shipper') {
        shipperId = newId('shp');
        await tx.query(`
          INSERT INTO shipper_profiles (id, user_id, company_name, billing_email)
          VALUES ($1, $2, $3, $4)
        `, [shipperId, userId, body.company_name || body.name, body.email]);
      }

      return { userId, driverId, shipperId };
    }, ENROLLMENT_CONTEXT);

    const token = generateToken({
      id: userId,
      email: body.email,
      role: body.role,
      driverId,
      shipperId
    });

    res.json({
      token,
      user: {
        id: userId,
        email: body.email,
        role: body.role,
        driverId,
        shipperId,
        name: body.name
      }
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message || 'Check the form and try again.' });
    }
    // Validation failures and duplicate emails are client errors, not 500s.
    res.status(err instanceof HttpError ? err.status : 400).json({ error: err.message });
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

// A real bcrypt digest of an unguessable value. Verifying against it for
// unknown accounts keeps failed-login timing identical either way.
const DUMMY_PASSWORD_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

apiRouter.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const authDb = db.as(AUTH_CONTEXT);
    const ip = clientIp(req);

    // Throttling lives in the database, so it holds across restarts and across
    // every server instance behind a load balancer.
    const lockRes = await authDb.query<{ seconds: string }>(
      'SELECT app_login_lockout_seconds($1) AS seconds', [email]
    );
    const lockedFor = parseInt(lockRes.rows[0]?.seconds ?? '0', 10);
    if (lockedFor > 0) {
      return res.status(429).json({
        error: `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
        retry_after_seconds: lockedFor
      });
    }

    const userRes = await authDb.query<{
      id: string;
      role: 'driver' | 'shipper' | 'admin';
      email: string;
      password_hash: string;
    }>('SELECT * FROM users WHERE email = $1', [email]);

    const user = userRes.rows[0];
    // Compare against a dummy hash when the account does not exist, so the
    // response time does not reveal which emails are registered.
    const storedHash = user?.password_hash ?? DUMMY_PASSWORD_HASH;
    const match = await bcrypt.compare(password, storedHash);

    if (!user || !match) {
      await authDb.query('SELECT app_record_login_attempt($1, $2, FALSE)', [email, ip]);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await authDb.query('SELECT app_record_login_attempt($1, $2, TRUE)', [email, ip]);

    let driverId: string | undefined;
    let shipperId: string | undefined;

    if (user.role === 'driver') {
      const drv = await authDb.query<{ id: string }>('SELECT id FROM driver_profiles WHERE user_id = $1', [user.id]);
      driverId = drv.rows[0]?.id;
    } else if (user.role === 'shipper') {
      const shp = await authDb.query<{ id: string }>('SELECT id FROM shipper_profiles WHERE user_id = $1', [user.id]);
      shipperId = shp.rows[0]?.id;
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      driverId,
      shipperId
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        driverId,
        shipperId
      }
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/auth/me', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  let profileData: any = {};
  if (req.user.role === 'driver' && req.user.driverId) {
    const drv = await scoped(req).query('SELECT * FROM driver_profiles WHERE id = $1', [req.user.driverId]);
    profileData = drv.rows[0] || {};
  } else if (req.user.role === 'shipper' && req.user.shipperId) {
    const shp = await scoped(req).query('SELECT * FROM shipper_profiles WHERE id = $1', [req.user.shipperId]);
    profileData = shp.rows[0] || {};
  }

  res.json({
    user: req.user,
    profile: profileData
  });
});

function likeContains(raw: string): string {
  return `%${raw.trim().replace(/[%_\\]/g, '')}%`;
}

function locationMatchSql(end: 'origin' | 'dest', paramIndex: number): string {
  return `(
    LOWER(l.${end}_city) LIKE LOWER($${paramIndex})
    OR LOWER(l.${end}_state) LIKE LOWER($${paramIndex})
    OR COALESCE(l.${end}_street, '') ILIKE $${paramIndex}
    OR COALESCE(l.${end}_zip, '') ILIKE $${paramIndex}
    OR COALESCE(l.${end}_address, '') ILIKE $${paramIndex}
    OR (l.${end}_city || ', ' || l.${end}_state) ILIKE $${paramIndex}
  )`;
}

function blankToNull(value?: string, max?: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return max && trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function geoFromLoadEnd(row: Record<string, unknown>, end: 'origin' | 'dest'): GeoPlace | null {
  const city = String(row[`${end}_city`] ?? '').trim();
  const state = String(row[`${end}_state`] ?? '').trim().toUpperCase();
  const latRaw = row[`${end}_lat`];
  const lngRaw = row[`${end}_lng`];
  if (!city || state.length !== 2 || latRaw == null || lngRaw == null) return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const street = blankToNull(row[`${end}_street`] as string | undefined) ?? undefined;
  const zip = blankToNull(row[`${end}_zip`] as string | undefined) ?? undefined;
  const label = blankToNull(row[`${end}_address`] as string | undefined)
    || formatPlaceLabel({ city, state, street, zip });
  return {
    city,
    state,
    lat,
    lng,
    street,
    zip,
    kind: street ? 'address' : zip ? 'postcode' : 'city',
    label
  };
}

// -------------------------------------------------------------
// 3. LOADS ENDPOINTS
// -------------------------------------------------------------

/** The caller's shipper profile id, looked up when an older token lacks it. */
async function shipperIdFor(req: AuthenticatedRequest): Promise<string | undefined> {
  if (req.user?.shipperId) return req.user.shipperId;
  const shp = await scoped(req).query<{ id: string }>('SELECT id FROM shipper_profiles WHERE user_id = $1', [req.user?.id]);
  return shp.rows[0]?.id;
}

apiRouter.get('/shipper/locations', authenticate, requireRole('shipper', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const shipperId = await shipperIdFor(req);
    if (!shipperId) {
      return res.json({ locations: [] as GeoPlace[] });
    }

    const result = await scoped(req, { shipperId }).query<Record<string, unknown>>(`
      SELECT origin_city, origin_state, origin_lat, origin_lng, origin_street, origin_zip, origin_address,
             dest_city, dest_state, dest_lat, dest_lng, dest_street, dest_zip, dest_address
      FROM loads
      WHERE shipper_id = $1
      ORDER BY created_at DESC
      LIMIT 40
    `, [shipperId]);

    const seen = new Set<string>();
    const locations: GeoPlace[] = [];
    for (const row of result.rows) {
      for (const end of ['origin', 'dest'] as const) {
        const place = geoFromLoadEnd(row, end);
        if (!place) continue;
        const key = place.label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        locations.push(place);
      }
    }
    res.json({ locations });
  } catch (err: any) {
    sendError(res, err);
  }
});

// A shipper's own loads, every status, for the dashboard. The board below is
// for carriers, so shippers read their loads here instead.
apiRouter.get('/shipper/loads', authenticate, requireRole('shipper'), async (req: AuthenticatedRequest, res) => {
  try {
    const shipperId = await shipperIdFor(req);
    if (!shipperId) return res.json({ loads: [] });

    const result = await scoped(req, { shipperId }).query(`
      SELECT * FROM loads
      WHERE shipper_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [shipperId]);
    res.json({ loads: result.rows });
  } catch (err: any) {
    sendError(res, err);
  }
});

// The load board: carriers and admins only. Drivers see open loads; only an
// admin may ask for other statuses.
apiRouter.get('/loads', authenticate, requireRole('driver', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const { origin, destination, equipment, minRate, pickupDate, page = '1', limit = '50' } = req.query;
    const status = req.user?.role === 'admin' ? (req.query.status ?? 'open') : 'open';

    // Joins the public projection, not shipper_profiles: that table holds
    // billing contacts behind RLS.
    let query = `
      SELECT l.*, s.company_name as shipper_name
      FROM loads l
      JOIN public_shipper_view s ON l.shipper_id = s.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status && status !== 'all') {
      params.push(status);
      query += ` AND l.status = $${params.length}`;
    }

    if (origin) {
      params.push(likeContains(String(origin)));
      query += ` AND ${locationMatchSql('origin', params.length)}`;
    }

    if (destination) {
      params.push(likeContains(String(destination)));
      query += ` AND ${locationMatchSql('dest', params.length)}`;
    }

    if (equipment && equipment !== 'Any') {
      params.push(equipment);
      query += ` AND l.equipment_type = $${params.length}`;
    }

    if (minRate) {
      params.push(parseFloat(minRate as string));
      query += ` AND l.rate_per_mile >= $${params.length}`;
    }

    if (pickupDate) {
      params.push(String(pickupDate));
      query += ` AND l.pickup_date = $${params.length}`;
    }

    query += ` ORDER BY l.created_at DESC`;

    const offset = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
    params.push(parseInt(limit as string, 10));
    query += ` LIMIT $${params.length}`;
    params.push(offset);
    query += ` OFFSET $${params.length}`;

    const result = await scoped(req).query(query, params);
    res.json({ loads: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// One load: carriers and admins, or the shipper who posted it. Another
// shipper's load answers 404 so ids cannot be probed.
apiRouter.get('/loads/:id', authenticate, requireRole('driver', 'shipper', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const party = await tripParty(req);
    const result = await party.db.query<any>(`
      SELECT l.*, s.company_name AS shipper_name, s.member_since AS shipper_member_since,
             s.loads_posted AS shipper_loads_posted
      FROM loads l
      JOIN public_shipper_view s ON l.shipper_id = s.id
      WHERE l.id = $1
    `, [req.params.id]);
    const load = result.rows[0];
    const notMine = req.user?.role === 'shipper' && load?.shipper_id !== party.shipperId;
    if (!load || notMine) return res.status(404).json({ error: 'Load not found' });

    const photos = await canSeeLoadPhotos(req, party, load)
      ? (await party.db.query(`
          SELECT id, caption, created_at FROM load_photos
          WHERE load_id = $1
          ORDER BY created_at, id
        `, [load.id])).rows
      : [];
    res.json({ ...load, photos });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Who may see a load's freight photos: the same audience as the load_photos RLS
 * policy. Checked here too because the embedded dev database runs as a
 * superuser, where the policy does not apply.
 */
async function canSeeLoadPhotos(
  req: AuthenticatedRequest,
  party: Awaited<ReturnType<typeof tripParty>>,
  load: { id: string; shipper_id: string; status: string }
): Promise<boolean> {
  if (req.user?.role === 'admin') return true;
  if (req.user?.role === 'shipper') return load.shipper_id === party.shipperId;
  if (!party.driverId) return false;
  if (load.status === 'open') return true;
  const held = await party.db.query(
    `SELECT 1 FROM bookings WHERE load_id = $1 AND driver_id = $2 AND status <> 'cancelled'`,
    [load.id, party.driverId]
  );
  return held.rows.length > 0;
}

// The bytes come through this route, not /uploads, so the rule above applies to
// the image itself and not only to the list of photos. The client fetches it
// with its token and shows the result.
apiRouter.get('/loads/:id/photos/:photoId', authenticate, requireRole('driver', 'shipper', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const party = await tripParty(req);
    const found = await party.db.query<any>(`
      SELECT p.file_id, l.id, l.shipper_id, l.status
      FROM load_photos p
      JOIN loads l ON l.id = p.load_id
      WHERE p.id = $1 AND p.load_id = $2
    `, [req.params.photoId, req.params.id]);
    const row = found.rows[0];
    if (!row || !(await canSeeLoadPhotos(req, party, row))) {
      throw new HttpError(404, 'Photo not found');
    }

    const file = await party.db.query<{ content_type: string; data: Buffer }>(
      'SELECT content_type, data FROM app_get_upload($1)',
      [row.file_id]
    );
    if (!file.rows[0]) throw new HttpError(404, 'Photo not found');
    res.setHeader('Content-Type', file.rows[0].content_type);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // The URL carries no identity, so a cached copy would skip the check above.
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(file.rows[0].data));
  } catch (err: any) {
    sendError(res, err);
  }
});

const photoCaptionSchema = z.string().trim().max(120, 'Captions are limited to 120 characters.').optional();

/** The routines in migration 0024 hold these rules; this gives them HTTP statuses. */
function loadPhotoError(err: any): any {
  if (err?.code === 'P0002') return new HttpError(404, err.message);
  if (err?.code === '23514') return new HttpError(409, err.message);
  return err;
}

apiRouter.post('/loads/:id/photos', authenticate, requireRole('shipper', 'admin'), (req: AuthenticatedRequest, res) => {
  photoUpload.single('photo')(req, res, (uploadErr: any) => {
    if (uploadErr) {
      const status = uploadErr instanceof HttpError ? uploadErr.status : uploadErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Photos are limited to 5 MB.' : uploadErr.message;
      return res.status(status).json({ error: message });
    }
    (async () => {
      if (!req.file) throw new HttpError(400, 'No photo uploaded');
      const contentType = sniffImageType(req.file.buffer);
      if (!contentType) throw new HttpError(415, 'Photos must be JPEG, PNG or WebP.');
      const caption = photoCaptionSchema.parse(req.body?.caption);

      const party = await tripParty(req);
      const id = newId('PH');
      await party.db.query(
        'SELECT app_add_load_photo($1, $2, $3, $4, $5, $6)',
        [id, newId('doc'), req.params.id, contentType, req.file.buffer, caption ?? null]
      ).catch(err => { throw loadPhotoError(err); });
      res.status(201).json({ id, caption: caption || null });
    })().catch(err => sendError(res, err));
  });
});

apiRouter.delete('/loads/:id/photos/:photoId', authenticate, requireRole('shipper', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const party = await tripParty(req);
    await party.db.query(
      'SELECT app_remove_load_photo($1, $2)',
      [req.params.photoId, req.params.id]
    ).catch(err => { throw loadPhotoError(err); });
    res.status(204).end();
  } catch (err: any) {
    sendError(res, err);
  }
});

const zipCodeSchema = z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 5 digits');

const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times must be HH:MM');
const shortText = (max: number) => z.string().trim().min(1).max(max).optional();

const createLoadSchema = z.object({
  origin_city: z.string().min(1),
  origin_state: z.string().length(2),
  dest_city: z.string().min(1),
  dest_state: z.string().length(2),
  origin_street: z.string().trim().min(1).max(120).optional(),
  dest_street: z.string().trim().min(1).max(120).optional(),
  origin_zip: zipCodeSchema.optional(),
  dest_zip: zipCodeSchema.optional(),
  origin_address: z.string().trim().min(1).max(200).optional(),
  dest_address: z.string().trim().min(1).max(200).optional(),
  origin_lat: z.number().gte(-90).lte(90).optional(),
  origin_lng: z.number().gte(-180).lte(180).optional(),
  dest_lat: z.number().gte(-90).lte(90).optional(),
  dest_lng: z.number().gte(-180).lte(180).optional(),
  miles: z.number().positive(),
  rate_per_mile: z.number().positive().optional(),
  equipment_type: equipmentKeySchema,
  pickup_date: z.string(),
  weight_lbs: z.number().optional(),
  notes: z.string().optional(),
  same_day_funding_offered: z.boolean().default(false),
  deadhead_miles: z.number().min(0).optional().default(0),
  demand_multiplier: z.number().positive().max(5).optional(),
  express: z.boolean().optional().default(false),
  accessorial_codes: z.array(z.string()).optional().default([]),
  load_type: z.enum(['full_truckload', 'partial']).optional(),
  pickup_appt_start: clockTimeSchema.optional(),
  pickup_appt_end: clockTimeSchema.optional(),
  pickup_dock: shortText(60),
  pickup_parking: shortText(300),
  pickup_checkin: shortText(300),
  delivery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Delivery date must be YYYY-MM-DD').optional(),
  delivery_appt_start: clockTimeSchema.optional(),
  delivery_appt_end: clockTimeSchema.optional(),
  delivery_dock: shortText(60),
  delivery_parking: shortText(300),
  receiving_hours: shortText(120),
  pallets: z.number().int().min(1).max(60).optional(),
  commodity: shortText(120),
  temperature_f: z.number().int().min(-40).max(120).optional(),
  hazmat: z.boolean().optional(),
  requires_twic: z.boolean().optional().default(false),
  requires_team: z.boolean().optional().default(false),
  requires_load_bars: z.boolean().optional().default(false),
  payment_terms: shortText(120)
}).refine(b => !b.delivery_date || b.delivery_date >= b.pickup_date, {
  message: 'Delivery date cannot be before the pickup date.'
}).refine(b => !b.pickup_appt_start || !b.pickup_appt_end || b.pickup_appt_end > b.pickup_appt_start, {
  message: 'Pickup appointment must end after it starts.'
}).refine(b => !b.delivery_appt_start || !b.delivery_appt_end || b.delivery_appt_end > b.delivery_appt_start, {
  message: 'Delivery appointment must end after it starts.'
});

apiRouter.post('/loads', authenticate, requireRole('shipper', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const body = createLoadSchema.parse(req.body);
    let shipperId = req.user?.shipperId;

    if (!shipperId) {
      const shp = await scoped(req).query<{ id: string }>('SELECT id FROM shipper_profiles WHERE user_id = $1', [req.user?.id]);
      shipperId = shp.rows[0]?.id;
    }

    if (!shipperId) {
      return res.status(400).json({ error: 'Shipper profile not found. Please complete shipper setup.' });
    }

    const { quote } = await quoteFor(scoped(req, { shipperId }), {
      equipment_key: body.equipment_type,
      miles: body.miles,
      deadhead_miles: body.deadhead_miles,
      demand_multiplier: body.demand_multiplier,
      express: body.express,
      accessorial_codes: body.accessorial_codes
    });

    const overridden = body.rate_per_mile != null
      && Math.abs(body.rate_per_mile - quote.quoted_rate_per_mile) > 0.0001;
    const postedRate = overridden ? body.rate_per_mile! : quote.quoted_rate_per_mile;
    if (postedRate <= 0) {
      return res.status(400).json({ error: 'Quoted rate must be greater than zero.' });
    }

    const loadId = newId('LD');
    const quoteId = newId('QT');
    // Written under the resolved shipper identity: RLS rejects any attempt to
    // post a load on another shipper's behalf.
    const created = await db.transaction(async tx => {
      await tx.query(`
        INSERT INTO loads (
          id, shipper_id, origin_city, origin_state, dest_city, dest_state,
          origin_street, origin_zip, origin_address, dest_street, dest_zip, dest_address,
          origin_lat, origin_lng, dest_lat, dest_lng,
          miles, rate_per_mile, equipment_type, pickup_date, weight_lbs, notes,
          same_day_funding_offered, status,
          load_type, pickup_appt_start, pickup_appt_end, pickup_dock, pickup_parking, pickup_checkin,
          delivery_date, delivery_appt_start, delivery_appt_end, delivery_dock, delivery_parking, receiving_hours,
          pallets, commodity, temperature_f, hazmat,
          requires_twic, requires_team, requires_load_bars, payment_terms
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, 'open',
          $24, $25, $26, $27, $28, $29,
          $30, $31, $32, $33, $34, $35,
          $36, $37, $38, $39,
          $40, $41, $42, $43
        )
      `, [
        loadId, shipperId, body.origin_city, body.origin_state, body.dest_city, body.dest_state,
        blankToNull(body.origin_street, 120), blankToNull(body.origin_zip), blankToNull(body.origin_address, 200),
        blankToNull(body.dest_street, 120), blankToNull(body.dest_zip), blankToNull(body.dest_address, 200),
        body.origin_lat ?? null, body.origin_lng ?? null, body.dest_lat ?? null, body.dest_lng ?? null,
        body.miles, postedRate, body.equipment_type, body.pickup_date,
        body.weight_lbs || null, body.notes || null, body.same_day_funding_offered,
        body.load_type ?? null, body.pickup_appt_start ?? null, body.pickup_appt_end ?? null,
        body.pickup_dock ?? null, body.pickup_parking ?? null, body.pickup_checkin ?? null,
        body.delivery_date ?? null, body.delivery_appt_start ?? null, body.delivery_appt_end ?? null,
        body.delivery_dock ?? null, body.delivery_parking ?? null, body.receiving_hours ?? null,
        body.pallets ?? null, body.commodity ?? null, body.temperature_f ?? null, body.hazmat ?? null,
        body.requires_twic, body.requires_team, body.requires_load_bars, body.payment_terms ?? null
      ]);

      await tx.query(`
        INSERT INTO rate_quotes (
          id, equipment_key, load_id, miles, deadhead_miles, demand_multiplier, express,
          breakdown, quoted_total, quoted_rate_per_mile, overridden,
          posted_rate_per_mile, actor_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
      `, [
        quoteId, body.equipment_type, loadId, body.miles, body.deadhead_miles ?? 0,
        quote.demand_multiplier, quote.express, JSON.stringify(quote),
        quote.quoted_total, quote.quoted_rate_per_mile, overridden, postedRate, req.user?.id
      ]);

      return tx.query('SELECT * FROM loads WHERE id = $1', [loadId]);
    }, { ...sessionContextFor(req), shipperId });

    res.status(201).json({ ...created.rows[0], quote, quote_id: quoteId, overridden });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4. BOOKINGS ENDPOINTS (TRANSACTIONAL LOCKING TO PREVENT DOUBLE BOOKING)
// -------------------------------------------------------------
// RLS already scopes this: a driver sees their own bookings, a shipper sees
// bookings on their loads, an admin sees all. No extra policy.
apiRouter.get('/bookings', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await scoped(req).query(`
      SELECT
        b.id, b.load_id, b.driver_id, b.booked_at, b.status, b.pod_url, b.delivered_at,
        l.origin_city, l.origin_state, l.dest_city, l.dest_state,
        l.origin_street, l.origin_zip, l.origin_address,
        l.dest_street, l.dest_zip, l.dest_address,
        l.miles, l.rate_per_mile, l.equipment_type, l.pickup_date,
        l.same_day_funding_offered, l.status AS load_status, l.shipper_id, l.weight_lbs, l.notes
      FROM bookings b
      JOIN loads l ON l.id = b.load_id
      ORDER BY b.booked_at DESC
    `);
    res.json({ bookings: result.rows });
  } catch (err: any) {
    sendError(res, err);
  }
});

apiRouter.post('/bookings', authenticate, requireRole('driver', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const { load_id } = req.body;
    if (!load_id) return res.status(400).json({ error: 'load_id is required' });

    let driverId = req.user?.driverId;
    if (!driverId) {
      const drv = await scoped(req).query<{ id: string }>('SELECT id FROM driver_profiles WHERE user_id = $1', [req.user?.id]);
      driverId = drv.rows[0]?.id;
    }
    if (!driverId) return res.status(400).json({ error: 'Driver profile required to book load' });

    // Everything below runs on one pooled connection inside one transaction:
    // the FOR UPDATE lock is only held for statements on that same client.
    const booking = await scoped(req, { driverId }).transaction(async tx => {
      // Read first, so a missing load and a taken load stay distinguishable.
      // (A driver cannot see other drivers' bookings under RLS, so "is it
      // taken?" is answered by the load's own status, not by scanning bookings.)
      const loadRes = await tx.query<{ status: string; id: string }>('SELECT * FROM loads WHERE id = $1', [load_id]);
      if (loadRes.rows.length === 0) {
        throw new HttpError(404, 'Load not found');
      }

      const load = loadRes.rows[0];
      if (load.status !== 'open') {
        throw new HttpError(409, 'Conflict: This load has already been booked or is no longer open.');
      }

      // Claim it: this blocks behind any competing booking and then re-checks
      // the status, so exactly one driver can leave this line holding the row.
      const claimed = await tx.query(
        `SELECT id FROM loads WHERE id = $1 AND status = 'open' FOR UPDATE`, [load_id]
      );
      if (claimed.rows.length === 0) {
        throw new HttpError(409, 'Conflict: This load has already been booked or is no longer open.');
      }

      const bookingId = newId('BK');
      try {
        await tx.query(`
          INSERT INTO bookings (id, load_id, driver_id, status)
          VALUES ($1, $2, $3, 'active')
        `, [bookingId, load_id, driverId]);
      } catch (err: any) {
        // Partial unique index on (load_id) WHERE status <> 'cancelled'.
        if (err?.code === '23505') {
          throw new HttpError(409, 'Conflict: Load is already booked');
        }
        throw err;
      }

      await tx.query(`UPDATE loads SET status = 'booked' WHERE id = $1`, [load_id]);

      const created = await tx.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
      return created.rows[0];
    });

    res.status(201).json(booking);
  } catch (err: any) {
    sendError(res, err);
  }
});

apiRouter.patch('/bookings/:id/pod', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const { pod_url } = req.body;
    if (!pod_url) return res.status(400).json({ error: 'pod_url is required' });

    // RLS restricts this UPDATE to the caller's own bookings, so an unmatched
    // row means the booking either does not exist or is not theirs — the same
    // answer either way, which avoids confirming other drivers' booking ids.
    const updated = await scoped(req).query(
      'UPDATE bookings SET pod_url = $1 WHERE id = $2 RETURNING *',
      [pod_url, req.params.id]
    );
    if (updated.rows.length === 0) {
      throw new HttpError(404, 'Booking not found');
    }
    res.json(updated.rows[0]);
  } catch (err: any) {
    sendError(res, err);
  }
});

// Complete Booking -> Authoritative Server-Side Settlement Trigger!
apiRouter.patch('/bookings/:id/complete', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    // The booking row is locked, the settlement is written, and both parent
    // rows are advanced in a single transaction: a settlement can never exist
    // for a booking that was not marked completed, or vice versa.
    const { settlement, load } = await scoped(req).transaction(async tx => {
      const bkRes = await tx.query<any>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (bkRes.rows.length === 0) {
        throw new HttpError(404, 'Booking not found');
      }

      const booking = bkRes.rows[0];

      // Completing a booking pays a carrier. Only the driver who hauled it, or
      // an admin, may trigger that — previously any signed-in account could
      // settle any booking.
      const isAdmin = req.user?.role === 'admin';
      if (!isAdmin && booking.driver_id !== req.user?.driverId) {
        throw new HttpError(403, 'Forbidden: only the booked driver can complete this load');
      }

      if (booking.status === 'completed') {
        throw new HttpError(400, 'Booking already completed');
      }

      const loadRes = await tx.query<any>('SELECT * FROM loads WHERE id = $1', [booking.load_id]);
      const load = loadRes.rows[0];
      if (!load) {
        throw new HttpError(404, 'Load not found for booking');
      }

      // Read platform config values
      const cfgRes = await tx.query<{ key: string; value: string }>('SELECT key, value FROM platform_config');
      const cfg: Record<string, number> = {};
      cfgRes.rows.forEach(r => cfg[r.key] = parseFloat(r.value));

      const feePct = cfg['fee_pct'] ?? 0.07;
      const factorPct = cfg['factor_pct'] ?? 0.03;

      // Check if driver opted into same-day funding
      const drvPayRes = await tx.query<any>('SELECT same_day_funding_opt_in FROM driver_payment_accounts WHERE driver_id = $1', [booking.driver_id]);
      const factored = drvPayRes.rows[0]?.same_day_funding_opt_in ?? load.same_day_funding_offered;

      // AUTHORITATIVE SETTLEMENT CALCULATIONS
      const miles = parseFloat(load.miles);
      const ratePerMile = parseFloat(load.rate_per_mile);
      const grossAmount = miles * ratePerMile;
      const feeAmount = grossAmount * feePct;
      const factorCost = factored ? grossAmount * factorPct : 0;
      const netAmount = grossAmount - feeAmount - factorCost;

      const settlementId = newId('STL');
      const settledAt = new Date().toISOString();

      await tx.query(`
        INSERT INTO settlements (
          id, booking_id, load_id, miles, rate_per_mile,
          gross_amount, fee_amount, fee_pct_applied, factor_cost, factored, net_amount, settled_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        settlementId, booking.id, load.id, miles, ratePerMile,
        grossAmount, feeAmount, feePct, factorCost, factored, netAmount, settledAt
      ]);

      await tx.query('UPDATE bookings SET status = \'completed\', delivered_at = $1 WHERE id = $2', [settledAt, booking.id]);
      await tx.query('UPDATE loads SET status = \'delivered\' WHERE id = $1', [load.id]);

      const settlementRes = await tx.query<Record<string, any>>('SELECT * FROM settlements WHERE id = $1', [settlementId]);
      return { settlement: settlementRes.rows[0] || {}, load };
    });

    // Broadcast SSE to live Open Books subscribers (only after COMMIT).
    broadcastSettlementEvent({
      ...settlement,
      origin_city: load.origin_city,
      origin_state: load.origin_state,
      dest_city: load.dest_city,
      dest_state: load.dest_state,
      equipment_type: load.equipment_type
    });

    res.json({
      message: 'Settlement created and load completed',
      settlement
    });
  } catch (err: any) {
    sendError(res, err);
  }
});

// -------------------------------------------------------------
// 4b. LIVE TRACKING
// -------------------------------------------------------------
// The driver's phone reports where the truck is while a trip is active, and
// the shipper of the load polls the latest position. Which bookings accept a
// position, who may read a trail, and when a truck has "arrived" are decided
// by migration 0022, not here.

type LatLng = { lat: number; lng: number };
type TripStop = 'pickup' | 'delivery';

/**
 * The caller's profile ids (filling in what an older token lacks) and a
 * database scope built from them. Routes still compare ids themselves, like
 * the settlement route does: the embedded dev database runs as a superuser,
 * so RLS alone would not keep one driver out of another's trip there.
 */
async function tripParty(req: AuthenticatedRequest) {
  let driverId = req.user?.driverId;
  let shipperId = req.user?.shipperId;
  if (req.user?.role === 'shipper') shipperId = await shipperIdFor(req);
  if (req.user?.role === 'driver' && !driverId) {
    const drv = await scoped(req).query<{ id: string }>('SELECT id FROM driver_profiles WHERE user_id = $1', [req.user.id]);
    driverId = drv.rows[0]?.id;
  }
  return { driverId, shipperId, db: scoped(req, { driverId, shipperId }) };
}

// Pickup is the one step the driver states by hand. The bookings trigger from
// migration 0007 moves the load to in_transit when `picked_up_at` is first set.
apiRouter.post('/bookings/:id/pickup', authenticate, requireRole('driver', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const party = await tripParty(req);
    const booking = await party.db.transaction(async tx => {
      const found = await tx.query<any>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id]);
      const row = found.rows[0];
      if (!row || (req.user?.role !== 'admin' && row.driver_id !== party.driverId)) {
        throw new HttpError(404, 'Booking not found');
      }
      if (row.status !== 'active') throw new HttpError(409, 'This booking is no longer active.');
      if (row.picked_up_at) return row;

      const updated = await tx.query('UPDATE bookings SET picked_up_at = now() WHERE id = $1 RETURNING *', [row.id]);
      return updated.rows[0];
    });
    res.json(booking);
  } catch (err: any) {
    sendError(res, err);
  }
});

const trackPointSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy_m: z.number().nonnegative().nullish(),
  speed_mps: z.number().nonnegative().nullish(),
  heading_deg: z.number().gte(0).lte(360).nullish(),
  recorded_at: z.iso.datetime()
});

// A phone that lost signal for a few hours uploads its backlog in pieces.
const trackBatchSchema = z.object({
  points: z.array(trackPointSchema).min(1).max(200)
});

apiRouter.post('/bookings/:id/locations', authenticate, requireRole('driver'), async (req: AuthenticatedRequest, res) => {
  try {
    const { points } = trackBatchSchema.parse(req.body);

    const limit = await hitRateLimit(`locations:${req.user?.id}`, 30, 60);
    if (limit && !limit.allowed) {
      res.setHeader('Retry-After', String(limit.retry_after || 60));
      return res.status(429).json({ error: 'Too many location uploads. Try again in a minute.' });
    }

    const params: unknown[] = [];
    const rows = points.map(p => {
      params.push(req.params.id, p.recorded_at, p.lat, p.lng, p.accuracy_m ?? null, p.speed_mps ?? null, p.heading_deg ?? null);
      const n = params.length;
      return `($${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });

    // The guard trigger checks the booking is this driver's, on every backend.
    const result = await (await tripParty(req)).db.query(`
      INSERT INTO booking_locations (booking_id, recorded_at, lat, lng, accuracy_m, speed_mps, heading_deg)
      VALUES ${rows.join(', ')}
      ON CONFLICT (booking_id, recorded_at) DO NOTHING
    `, params);
    res.json({ accepted: result.rowCount });
  } catch (err: any) {
    // The guard trigger answers for the database: a booking that is not this
    // driver's is not found, and a finished trip tells the phone to stop.
    if (err?.code === 'P0002' || err?.code === '42501') {
      return sendError(res, new HttpError(404, 'Booking not found'));
    }
    if (err?.code === '23514') {
      return sendError(res, new HttpError(409, 'Tracking is off: this trip is no longer active.'));
    }
    sendError(res, err);
  }
});

/** Stops posted before loads carried coordinates are geocoded once and remembered. */
const stopCoordCache = new Map<string, LatLng | null>();

async function stopCoords(lat: unknown, lng: unknown, city: string, state: string, address?: string | null): Promise<LatLng | null> {
  if (lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
    return { lat: Number(lat), lng: Number(lng) };
  }
  const q = address || `${city}, ${state}`;
  if (stopCoordCache.has(q)) return stopCoordCache.get(q) ?? null;
  try {
    const hit = (await searchPlaces(q))[0];
    const coords = hit ? { lat: hit.lat, lng: hit.lng } : null;
    stopCoordCache.set(q, coords);
    return coords;
  } catch {
    return null; // Not cached, so the next poll tries again.
  }
}

// Shippers poll every few seconds and the public router asks for gentle use,
// so a road route is reused until the truck has moved or a minute has passed.
const ROUTE_CACHE_LIMIT = 500;
const tripRouteCache = new Map<string, { stop: TripStop; key: string; at: number; route: GeoRoute }>();
const laneRouteCache = new Map<string, GeoRoute>();

function remember<V>(cache: Map<string, V>, key: string, value: V) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > ROUTE_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

async function routeToStop(bookingId: string, from: LatLng, stop: TripStop, to: LatLng): Promise<GeoRoute> {
  const key = `${from.lat.toFixed(3)}|${from.lng.toFixed(3)}`;
  const hit = tripRouteCache.get(bookingId);
  if (hit && hit.stop === stop && (hit.key === key || Date.now() - hit.at < 60_000)) return hit.route;
  const route = await drivingRoute(from, to);
  remember(tripRouteCache, bookingId, { stop, key, at: Date.now(), route });
  return route;
}

async function laneRoute(loadId: string, from: LatLng, to: LatLng): Promise<GeoRoute> {
  const hit = laneRouteCache.get(loadId);
  if (hit) return hit;
  const route = await drivingRoute(from, to);
  remember(laneRouteCache, loadId, route);
  return route;
}

/** At most `max` points, evenly spaced, always ending on the latest one. */
function thinTrail(points: [number, number][], max: number): [number, number][] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const thinned = points.filter((_, i) => i % step === 0);
  if (thinned[thinned.length - 1] !== points[points.length - 1]) thinned.push(points[points.length - 1]);
  return thinned;
}

// One trip as both parties see it: the stops, where the truck is, the road
// left to the next stop, and the timeline. Anyone who is not the driver, the
// shipper of the load, or an admin gets 404, so booking ids cannot be probed.
apiRouter.get('/bookings/:id/tracking', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const party = await tripParty(req);
    const trips = party.db;
    const tripRes = await trips.query<any>(`
      SELECT b.id, b.load_id, b.driver_id, b.status, b.booked_at, b.picked_up_at, b.delivered_at, b.pod_url,
             l.shipper_id, l.status AS load_status, l.origin_city, l.origin_state, l.origin_address, l.origin_lat, l.origin_lng,
             l.dest_city, l.dest_state, l.dest_address, l.dest_lat, l.dest_lng,
             l.pickup_date, l.delivery_date, l.miles, l.equipment_type, l.reference_number, l.weight_lbs
        FROM bookings b
        JOIN loads l ON l.id = b.load_id
       WHERE b.id = $1
    `, [req.params.id]);
    const trip = tripRes.rows[0];
    const isParty = req.user?.role === 'admin'
      || (req.user?.role === 'driver' && !!party.driverId && trip?.driver_id === party.driverId)
      || (req.user?.role === 'shipper' && !!party.shipperId && trip?.shipper_id === party.shipperId);
    if (!trip || !isParty) throw new HttpError(404, 'Booking not found');

    const [pointsRes, eventsRes, pickup, delivery] = await Promise.all([
      trips.query<any>(`
        SELECT lat, lng, accuracy_m, speed_mps, heading_deg, recorded_at
          FROM booking_locations
         WHERE booking_id = $1
         ORDER BY recorded_at DESC
         LIMIT 5000
      `, [trip.id]),
      // 'posted' predates any booking; everything else belongs to this one, so
      // a cancelled earlier booking of the same load stays out of the story.
      trips.query<any>(`
        SELECT event_type, occurred_at, notes, location_city, location_state
          FROM load_events
         WHERE load_id = $1 AND (booking_id = $2 OR event_type = 'posted')
         ORDER BY occurred_at
      `, [trip.load_id, trip.id]),
      stopCoords(trip.origin_lat, trip.origin_lng, trip.origin_city, trip.origin_state, trip.origin_address),
      stopCoords(trip.dest_lat, trip.dest_lng, trip.dest_city, trip.dest_state, trip.dest_address)
    ]);

    const phase =
      trip.status === 'cancelled' || trip.load_status === 'cancelled' ? 'cancelled'
        : trip.status === 'completed' || trip.load_status === 'delivered' ? 'delivered'
          : trip.picked_up_at ? 'to_delivery' : 'to_pickup';

    const latest = pointsRes.rows[0];
    const last = latest ? {
      lat: Number(latest.lat),
      lng: Number(latest.lng),
      accuracy_m: latest.accuracy_m == null ? null : Number(latest.accuracy_m),
      speed_mps: latest.speed_mps == null ? null : Number(latest.speed_mps),
      heading_deg: latest.heading_deg == null ? null : Number(latest.heading_deg),
      recorded_at: latest.recorded_at
    } : null;
    const trail = thinTrail(
      pointsRes.rows.slice().reverse().map((p): [number, number] => [Number(p.lat), Number(p.lng)]),
      500
    );

    const nextStop: TripStop | null = phase === 'to_pickup' ? 'pickup' : phase === 'to_delivery' ? 'delivery' : null;
    const target = nextStop === 'pickup' ? pickup : nextStop === 'delivery' ? delivery : null;
    const [toStop, lane] = await Promise.all([
      nextStop && target && last ? routeToStop(trip.id, last, nextStop, target) : null,
      pickup && delivery ? laneRoute(trip.load_id, pickup, delivery) : null
    ]);

    res.json({
      booking: {
        id: trip.id,
        load_id: trip.load_id,
        status: trip.status,
        booked_at: trip.booked_at,
        picked_up_at: trip.picked_up_at,
        delivered_at: trip.delivered_at,
        pod_attached: Boolean(trip.pod_url)
      },
      load: {
        id: trip.load_id,
        status: trip.load_status,
        origin_city: trip.origin_city,
        origin_state: trip.origin_state,
        origin_address: trip.origin_address,
        dest_city: trip.dest_city,
        dest_state: trip.dest_state,
        dest_address: trip.dest_address,
        pickup_date: trip.pickup_date,
        delivery_date: trip.delivery_date,
        miles: Number(trip.miles),
        equipment_type: trip.equipment_type,
        reference_number: trip.reference_number,
        weight_lbs: trip.weight_lbs == null ? null : Number(trip.weight_lbs)
      },
      phase,
      stops: { pickup, delivery },
      last,
      trail,
      remaining: nextStop && toStop ? { stop: nextStop, ...toStop } : null,
      lane: lane?.geometry ?? null,
      events: eventsRes.rows
    });
  } catch (err: any) {
    sendError(res, err);
  }
});

// -------------------------------------------------------------
// 5. SETTLEMENTS ENDPOINTS (OPEN BOOKS PUBLIC LEDGER)
// -------------------------------------------------------------
apiRouter.get('/settlements', async (req, res) => {
  try {
    const { limit = '50', page = '1' } = req.query;
    const l = parseInt(limit as string, 10);
    const offset = (parseInt(page as string, 10) - 1) * l;

    const rows = await db.as({ role: 'anon' }).query('SELECT * FROM public_ledger_view LIMIT $1 OFFSET $2', [l, offset]);
    res.json({ settlements: rows.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/settlements/aggregate', async (req, res) => {
  try {
    const rows = await db.as({ role: 'anon' }).query<Record<string, any>>('SELECT * FROM settlement_totals_view');
    const totals: Record<string, any> = rows.rows[0] || { count: 0, miles: 0, gross: 0, fee: 0, factor: 0, net: 0 };
    res.json({
      count: parseInt(String(totals.count || '0'), 10),
      miles: parseFloat(String(totals.miles || '0')),
      gross: parseFloat(String(totals.gross || '0')),
      fee: parseFloat(String(totals.fee || '0')),
      factor: parseFloat(String(totals.factor || '0')),
      net: parseFloat(String(totals.net || '0'))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 6. DRIVER ONBOARDING & DOCUMENTS
// -------------------------------------------------------------
const driverOnboardSchema = z.object({
  full_name: z.string().min(2),
  // Contact phone is recorded on the users row at signup. `users` is granted
  // SELECT/INSERT only — deliberately, so the app can never rewrite a password
  // hash or a role — so onboarding does not attempt to change it here.
  home_base_city: z.string(),
  home_base_state: z.string(),
  cdl_number: z.string().optional(),
  cdl_class: z.enum(['A', 'B']).optional(),
  dot_number: z.string().optional(),
  mc_number: z.string().optional(),
  equipment_type: equipmentKeySchema,
  trailer_length_ft: z.number().optional().default(53),
  routing_number: z.string().optional(),
  account_number: z.string().optional(),
  same_day_funding_opt_in: z.boolean().default(false),
  cdl_photo_url: z.string().min(1).optional(),
  dot_authority_url: z.string().min(1).optional(),
  coi_url: z.string().min(1).optional()
});

/**
 * Completes the signed-in driver's carrier profile.
 *
 * Identity comes from the verified token, never from the request body. An
 * earlier version accepted an email, looked the user up by it, and upserted
 * their payment account — which let anyone who knew a driver's address point
 * that driver's settlements at their own bank. There is deliberately no way to
 * name a subject here: the route can only ever write the caller's own rows, and
 * migration 0005 enforces the same rule underneath it.
 */
apiRouter.post('/drivers/onboard', authenticate, requireRole('driver', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const body = driverOnboardSchema.parse(req.body);
    const user = req.user!;

    // Bank details are optional here; when present, both halves are required to
    // derive a token, and the raw numbers never reach the database.
    const hasBankDetails = Boolean(body.routing_number && body.account_number);
    if ((body.routing_number || body.account_number) && !hasBankDetails) {
      throw new HttpError(400, 'Both routing number and account number are required to update payout details.');
    }
    const last4 = hasBankDetails ? accountLast4(body.account_number) : null;

    const { driverId } = await db.transaction(async tx => {
      // The profile is located by the caller's own user id. RLS scopes every
      // statement below to this driver regardless of what the body asked for.
      const drvRes = await tx.query<{ id: string }>(
        'SELECT id FROM driver_profiles WHERE user_id = $1',
        [user.id]
      );
      if (drvRes.rows.length === 0) {
        throw new HttpError(404, 'No driver profile for this account. Sign up as a driver first.');
      }
      const driverId = drvRes.rows[0].id;

      await tx.query(`
        UPDATE driver_profiles
        SET full_name = $1, home_base_city = $2, home_base_state = $3, cdl_number = $4,
            cdl_class = $5, dot_number = $6, mc_number = $7
        WHERE id = $8
      `, [body.full_name, body.home_base_city, body.home_base_state, body.cdl_number || null,
          body.cdl_class || 'A', body.dot_number || null, body.mc_number || null, driverId]);

      await tx.query(`
        INSERT INTO driver_equipment (id, driver_id, equipment_type, trailer_length_ft)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET equipment_type = EXCLUDED.equipment_type, trailer_length_ft = EXCLUDED.trailer_length_ft
      `, ['eq-' + driverId, driverId, body.equipment_type, body.trailer_length_ft]);

      if (hasBankDetails) {
        // Tokenize before anything touches the database. This is an HMAC, not
        // an encoding: the raw routing/account numbers cannot be recovered from
        // what gets stored.
        const tokenizedProcessorAcct = tokenizeBankAccount(body.routing_number, body.account_number);
        await tx.query(`
          INSERT INTO driver_payment_accounts (id, driver_id, payment_processor, processor_account_id, same_day_funding_opt_in)
          VALUES ($1, $2, 'stripe_connect', $3, $4)
          ON CONFLICT (driver_id) DO UPDATE SET processor_account_id = EXCLUDED.processor_account_id, same_day_funding_opt_in = EXCLUDED.same_day_funding_opt_in
        `, ['pay-' + driverId, driverId, tokenizedProcessorAcct, body.same_day_funding_opt_in]);
      } else {
        await tx.query(
          'UPDATE driver_payment_accounts SET same_day_funding_opt_in = $1 WHERE driver_id = $2',
          [body.same_day_funding_opt_in, driverId]
        );
      }

      const documents: Array<{ type: 'cdl_photo' | 'dot_authority' | 'coi'; url?: string }> = [
        { type: 'cdl_photo', url: body.cdl_photo_url },
        { type: 'dot_authority', url: body.dot_authority_url },
        { type: 'coi', url: body.coi_url }
      ];
      for (const doc of documents) {
        if (!doc.url) continue;
        await tx.query(
          `INSERT INTO driver_documents (id, driver_id, doc_type, file_url)
           VALUES ($1, $2, $3, $4)`,
          [newId('doc'), driverId, doc.type, doc.url]
        );
      }

      return { driverId };
    }, sessionContextFor(req));

    // Reissue so the token carries the driver id for subsequent booking calls.
    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      driverId
    });

    res.status(200).json({
      message: 'Driver onboarded successfully',
      token,
      driverId,
      payment_account_last4: last4
    });
  } catch (err: any) {
    sendError(res, err);
  }
});

// File upload endpoint.
//
// Authenticated: this writes attacker-controlled bytes to the server's disk, so
// leaving it open let anyone fill the volume 10MB at a time. Driver documents
// are uploaded after the account exists, so the wizard always holds a token by
// the time it reaches this route.
apiRouter.post('/uploads/file', authenticate, (req, res) => {
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      const status = err instanceof HttpError ? err.status : err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    handleUpload(req, res).catch(e => sendError(res, e));
  });
});

async function handleUpload(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }
  const id = newId('doc');
  const fileUrl = `/uploads/${id}${ALLOWED_UPLOAD_TYPES[req.file.mimetype] || '.bin'}`;
  await db.as(sessionContextFor(req as AuthenticatedRequest)).query(
    'SELECT app_store_upload($1, $2, $3)',
    [id, req.file.mimetype, req.file.buffer]
  );
  res.json({
    file_url: fileUrl,
    filename: req.file.originalname,
    size: req.file.size
  });
}

/**
 * Serves a stored document as a download, never as a live document: files come
 * from users and share the app's origin, so inline rendering would let one run
 * script in the application's context.
 */
export async function serveUpload(req: Request, res: Response): Promise<void> {
  const id = path.parse(req.params.name).name;
  try {
    const result = await db.as({ role: 'anon' }).query<{ content_type: string; data: Buffer }>(
      'SELECT content_type, data FROM app_get_upload($1)',
      [id]
    );
    const file = result.rows[0];
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(Buffer.from(file.data));
  } catch (err) {
    sendError(res, err);
  }
}

// Mock S3 signed URL generator
apiRouter.get('/uploads/signed-url', authenticate, (req, res) => {
  const { filename = 'document.pdf', doc_type = 'coi' } = req.query;
  const key = `uploads/${newId('doc')}-${filename}`;
  res.json({
    upload_url: `/api/uploads/file`,
    file_url: `/${key}`,
    expires_in: 3600
  });
});

// -------------------------------------------------------------
// 7. ADMIN ENDPOINTS
// -------------------------------------------------------------
apiRouter.get('/admin/ledger', authenticate, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await scoped(req).query(`
      SELECT 
        s.*,
        l.origin_city, l.origin_state, l.dest_city, l.dest_state, l.equipment_type,
        d.full_name as driver_name, d.cdl_number,
        sp.company_name as shipper_name
      FROM settlements s
      JOIN loads l ON s.load_id = l.id
      JOIN bookings b ON s.booking_id = b.id
      JOIN driver_profiles d ON b.driver_id = d.id
      JOIN shipper_profiles sp ON l.shipper_id = sp.id
      ORDER BY s.settled_at DESC
    `);
    res.json({ ledger: rows.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/admin/export', authenticate, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await scoped(req).query(`
      SELECT 
        s.id, s.booking_id, s.load_id,
        l.origin_city, l.origin_state, l.dest_city, l.dest_state, l.equipment_type,
        s.miles, s.rate_per_mile,
        s.gross_amount, s.fee_amount, s.factor_cost, s.factored, s.net_amount, s.settled_at
      FROM settlements s
      JOIN loads l ON s.load_id = l.id
      ORDER BY s.settled_at DESC
    `);

    const headers = [
      'settlement_id', 'booking_id', 'load_id', 'origin', 'destination', 'equipment',
      'miles', 'rate_per_mile', 'gross_amount', 'fee_amount',
      'factor_cost', 'factored', 'net_amount', 'settled_at'
    ];

    let csvContent = headers.join(',') + '\n';
    rows.rows.forEach((r: any) => {
      const line = [
        r.id, r.booking_id, r.load_id,
        `"${r.origin_city}, ${r.origin_state}"`, `"${r.dest_city}, ${r.dest_state}"`, r.equipment_type,
        r.miles, r.rate_per_mile,
        r.gross_amount, r.fee_amount, r.factor_cost, r.factored, r.net_amount, r.settled_at
      ];
      csvContent += line.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="open-books-ledger-export.csv"');
    res.send(csvContent);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const rateCardPatchSchema = z.object({
  rate_min_per_mile: z.number().positive().optional(),
  rate_max_per_mile: z.number().positive().optional(),
  base_rate_per_mile: z.number().positive().optional(),
  short_haul_under_miles: z.number().positive().nullable().optional(),
  short_haul_rate_min_per_mile: z.number().positive().nullable().optional(),
  short_haul_rate_max_per_mile: z.number().positive().nullable().optional(),
  short_haul_base_rate_per_mile: z.number().positive().nullable().optional(),
  minimum_charge: z.number().min(0).optional(),
  short_haul_minimum_charge: z.number().min(0).nullable().optional(),
  deadhead_buffer_pct: z.number().min(0).max(1).optional(),
  express_surcharge_pct: z.number().min(0).max(1).optional()
});

apiRouter.patch('/admin/rate-cards/:key', authenticate, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const key = equipmentKeySchema.parse(req.params.key);
    const body = rateCardPatchSchema.parse(req.body);
    const entries = Object.entries(body).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return res.status(400).json({ error: 'No rate-card fields to update.' });
    }
    const sets = entries.map(([col], i) => `${col} = $${i + 2}`);
    const params = [key, ...entries.map(([, v]) => v)];
    const updated = await scoped(req).query(
      `UPDATE equipment_rate_cards SET ${sets.join(', ')} WHERE equipment_key = $1 RETURNING *`,
      params
    );
    if (!updated.rowCount) return res.status(404).json({ error: 'Rate card not found' });
    res.json({ card: cardFromRow(updated.rows[0]) });
  } catch (err: any) {
    sendError(res, err);
  }
});

apiRouter.patch('/admin/accessorials/:code', authenticate, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const code = z.string().regex(/^[a-z][a-z0-9_]*$/).parse(req.params.code);
    const body = z.object({ amount: z.number().min(0) }).parse(req.body);
    const updated = await scoped(req).query(
      `UPDATE accessorial_fees SET amount = $2, updated_at = now() WHERE code = $1 RETURNING *`,
      [code, body.amount]
    );
    if (!updated.rowCount) return res.status(404).json({ error: 'Accessorial not found' });
    res.json({ accessorial: updated.rows[0] });
  } catch (err: any) {
    sendError(res, err);
  }
});

apiRouter.get('/admin/quotes', authenticate, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await scoped(req).query(`
      SELECT q.*, c.label AS equipment_label
      FROM rate_quotes q
      JOIN equipment_rate_cards c ON c.equipment_key = q.equipment_key
      ORDER BY q.created_at DESC
      LIMIT 100
    `);
    res.json({ quotes: rows.rows });
  } catch (err: any) {
    sendError(res, err);
  }
});

// -------------------------------------------------------------
// ADMIN DRIVER VERIFICATION
// -------------------------------------------------------------
apiRouter.patch('/admin/drivers/:id/verify', authenticate, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const driverId = req.params.id;
    const { status, rejection_reason } = req.body;
    if (!['verified', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const dbx = scoped(req);
    const result = await dbx.query(`
      UPDATE driver_profiles
      SET verification_status = $1::text::verification_status,
          verified_at = CASE WHEN $1::text = 'verified' THEN CURRENT_TIMESTAMP ELSE NULL END,
          rejection_reason = $2
      WHERE id = $3
      RETURNING id, full_name, verification_status, verified_at, rejection_reason
    `, [status, rejection_reason || null, driverId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }
    res.json({ success: true, driver: result.rows[0] });
  } catch (err: any) {
    sendError(res, err);
  }
});

apiRouter.get('/admin/directory', authenticate, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const dbx = scoped(req);
    const [drivers, shippers] = await Promise.all([
      dbx.query(`
        SELECT
          d.id,
          d.full_name,
          d.home_base_city,
          d.home_base_state,
          d.cdl_number,
          d.cdl_class,
          d.dot_number,
          d.mc_number,
          d.verification_status,
          d.verified_at,
          d.rejection_reason,
          d.insurance_expires_at,
          d.created_at,
          u.email,
          u.phone,
          COALESCE(pay.same_day_funding_opt_in, false) AS same_day_funding_opt_in,
          (pay.id IS NOT NULL) AS payout_on_file,
          COALESCE((
            SELECT json_agg(json_build_object(
              'equipment_type', e.equipment_type,
              'trailer_length_ft', e.trailer_length_ft
            ))
            FROM driver_equipment e
            WHERE e.driver_id = d.id
          ), '[]'::json) AS equipment,
          COALESCE((
            SELECT json_agg(json_build_object(
              'id', doc.id,
              'doc_type', doc.doc_type,
              'file_url', doc.file_url,
              'uploaded_at', doc.uploaded_at,
              'review_status', COALESCE(doc.review_status::text, CASE WHEN doc.verified THEN 'verified' ELSE 'pending' END)
            ) ORDER BY doc.uploaded_at DESC)
            FROM driver_documents doc
            WHERE doc.driver_id = d.id
          ), '[]'::json) AS documents,
          (SELECT COUNT(*)::int FROM bookings b WHERE b.driver_id = d.id) AS booking_count,
          (SELECT COUNT(*)::int FROM bookings b WHERE b.driver_id = d.id AND b.status = 'active') AS active_booking_count
        FROM driver_profiles d
        JOIN users u ON u.id = d.user_id
        LEFT JOIN driver_payment_accounts pay ON pay.driver_id = d.id
        ORDER BY d.created_at DESC
      `),
      dbx.query(`
        SELECT
          sp.id,
          sp.company_name,
          sp.billing_email,
          sp.created_at,
          u.email,
          u.phone,
          (SELECT COUNT(*)::int FROM loads l WHERE l.shipper_id = sp.id) AS load_count,
          (SELECT COUNT(*)::int FROM loads l WHERE l.shipper_id = sp.id AND l.status = 'open') AS open_load_count,
          COALESCE((
            SELECT json_agg(json_build_object(
              'id', recent.id,
              'origin_city', recent.origin_city,
              'origin_state', recent.origin_state,
              'dest_city', recent.dest_city,
              'dest_state', recent.dest_state,
              'miles', recent.miles,
              'rate_per_mile', recent.rate_per_mile,
              'equipment_type', recent.equipment_type,
              'status', recent.status,
              'pickup_date', recent.pickup_date
            ) ORDER BY recent.created_at DESC)
            FROM (
              SELECT *
              FROM loads
              WHERE shipper_id = sp.id
              ORDER BY created_at DESC
              LIMIT 8
            ) recent
          ), '[]'::json) AS recent_loads
        FROM shipper_profiles sp
        JOIN users u ON u.id = sp.user_id
        ORDER BY sp.created_at DESC
      `)
    ]);
    const asList = (value: unknown) => {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return [];
    };
    res.json({
      drivers: drivers.rows.map((row: any) => ({
        ...row,
        equipment: asList(row.equipment),
        documents: asList(row.documents),
        payout_on_file: Boolean(row.payout_on_file),
        same_day_funding_opt_in: Boolean(row.same_day_funding_opt_in)
      })),
      shippers: shippers.rows.map((row: any) => ({
        ...row,
        recent_loads: asList(row.recent_loads)
      }))
    });
  } catch (err: any) {
    sendError(res, err);
  }
});

// -------------------------------------------------------------
// 8. REAL-TIME SSE STREAM ENDPOINT
// -------------------------------------------------------------
apiRouter.get('/realtime/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  // Send welcome ping
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Subscribed to Open Books real-time stream' })}\n\n`);

  // Heartbeat every 15s to keep container HTTP proxy alive
  const heartbeat = setInterval(() => {
    res.write(`:ping\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});
