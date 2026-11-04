/**
 * Continue with Google.
 *
 * The browser hands us the ID token Google issued; everything the server
 * believes comes from verifying that token here, never from fields the browser
 * sends alongside it.
 *
 * What a verified Google login does:
 *   - Already linked: signs in with the account's existing role.
 *   - No account for the address: asks the visitor to choose driver or shipper,
 *     then creates the same rows password signup creates.
 *   - A password account has the address: links only after the account's
 *     password is entered. Password signup does not prove ownership of an
 *     address, so linking on the email alone would hand a real owner an account
 *     that whoever registered it first can still open.
 *   - An administrator: refused. Those accounts sign in with a password.
 */
import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { Database } from '../database';
import { createAccountRows } from './accounts';
import { generateToken } from './auth';
import { clientIp, newId } from './security';

export interface GoogleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/** Throws GoogleTokenError unless the credential is a valid token for this app. */
export type GoogleVerifier = (credential: string) => Promise<GoogleClaims>;

export class GoogleTokenError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

export function googleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID?.trim() || null;
}

/**
 * verifyIdToken checks the signature against Google's published keys, the
 * audience, the issuer, and the expiry. A client can be passed in so tests can
 * exercise those checks with their own keys.
 */
export function createGoogleVerifier(clientId: string, client = new OAuth2Client(clientId)): GoogleVerifier {
  return async credential => {
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch (err: any) {
      // Not reaching Google's keys says nothing about the token.
      if (err?.name === 'GaxiosError') {
        throw new GoogleTokenError(503, 'Could not reach Google. Try again in a moment.');
      }
      throw new GoogleTokenError(401, 'Your Google sign-in could not be verified. Try again.');
    }
    if (!payload?.sub || !payload.email) {
      throw new GoogleTokenError(401, 'Your Google sign-in could not be verified. Try again.');
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: payload.name
    };
  };
}

/** Shared rate limiter, held in the database so it applies across instances. */
export async function rateLimitHit(database: Pick<Database, 'as'>, bucket: string, limit: number, windowSecs: number) {
  const limitRes = await database.as({ role: 'anon' }).query<{
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

// `role` is only read when creating an account, and 'admin' is not accepted.
// An existing account keeps its role whatever is sent here.
const googleAuthSchema = z.object({
  credential: z.string().min(1).max(8192),
  role: z.enum(['driver', 'shipper']).optional(),
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(80).optional(),
  company_name: z.string().trim().min(2, 'Enter at least 2 characters.').max(80).optional(),
  phone: z.string().trim().max(32).optional(),
  home_city: z.string().trim().max(80).optional(),
  home_state: z.string().trim().max(32).optional(),
  password: z.string().max(200).optional()
});

interface AccountRow {
  id: string;
  role: 'driver' | 'shipper' | 'admin';
  email: string;
}

const ADMIN_REFUSED = 'Administrator accounts sign in with their password.';

export function createGoogleAuthHandler(deps: { db: Database; verifier?: GoogleVerifier }) {
  const { db } = deps;
  let cached: { clientId: string; verify: GoogleVerifier } | null = null;

  const verifierFor = (clientId: string): GoogleVerifier => {
    if (deps.verifier) return deps.verifier;
    if (cached?.clientId !== clientId) {
      cached = { clientId, verify: createGoogleVerifier(clientId) };
    }
    return cached.verify;
  };

  /** Checked on every path that signs in, so no route to a session skips it. */
  const signIn = async (res: Response, account: AccountRow) => {
    if (account.role === 'admin') {
      return res.status(403).json({ error: ADMIN_REFUSED });
    }

    const authDb = db.as({ role: 'auth' });
    let driverId: string | undefined;
    let shipperId: string | undefined;
    if (account.role === 'driver') {
      const drv = await authDb.query<{ id: string }>('SELECT id FROM driver_profiles WHERE user_id = $1', [account.id]);
      driverId = drv.rows[0]?.id;
    } else {
      const shp = await authDb.query<{ id: string }>('SELECT id FROM shipper_profiles WHERE user_id = $1', [account.id]);
      shipperId = shp.rows[0]?.id;
    }

    const session = { id: account.id, email: account.email, role: account.role, driverId, shipperId };
    return res.json({ status: 'signed_in', token: generateToken(session), user: session });
  };

  return async (req: Request, res: Response) => {
    const clientId = googleClientId();
    if (!clientId) {
      return res.status(404).json({ error: 'Google sign-in is not available.' });
    }

    try {
      const parsed = googleAuthSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the form and try again.' });
      }
      const body = parsed.data;
      const ip = clientIp(req);

      const limit = await rateLimitHit(db, `google:${ip}`, 30, 60);
      if (limit && !limit.allowed) {
        res.setHeader('Retry-After', String(limit.retry_after || 60));
        return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
      }

      const claims = await verifierFor(clientId)(body.credential);
      if (!claims.emailVerified) {
        return res.status(403).json({ error: 'Google has not verified this email address, so it cannot be used to sign in.' });
      }

      const authDb = db.as({ role: 'auth' });

      const linked = await authDb.query<AccountRow>(`
        SELECT u.id, u.role, u.email
        FROM user_google_identities g JOIN users u ON u.id = g.user_id
        WHERE g.google_sub = $1
      `, [claims.sub]);
      if (linked.rows[0]) {
        return await signIn(res, linked.rows[0]);
      }

      // Addresses are not unique by case in older rows. An administrator match
      // sorts first so a differently-cased row cannot be used to step around it.
      const existing = await authDb.query<AccountRow & { password_hash: string | null; linked_sub: string | null }>(`
        SELECT u.id, u.role, u.email, u.password_hash, g.google_sub AS linked_sub
        FROM users u LEFT JOIN user_google_identities g ON g.user_id = u.id
        WHERE lower(u.email) = $1
        ORDER BY (u.role = 'admin') DESC, u.created_at ASC
        LIMIT 1
      `, [claims.email]);
      const account = existing.rows[0];

      if (account) {
        if (account.role === 'admin') {
          return res.status(403).json({ error: ADMIN_REFUSED });
        }
        if (account.linked_sub || !account.password_hash) {
          return res.status(409).json({ error: 'This account is linked to a different Google login.' });
        }
        if (body.password === undefined) {
          return res.json({ status: 'link_required', email: account.email });
        }

        // The same throttle as password login, because this is a password check.
        const lockRes = await authDb.query<{ seconds: string }>(
          'SELECT app_login_lockout_seconds($1) AS seconds', [account.email]
        );
        const lockedFor = parseInt(lockRes.rows[0]?.seconds ?? '0', 10);
        if (lockedFor > 0) {
          return res.status(429).json({
            error: `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
            retry_after_seconds: lockedFor
          });
        }

        const match = await bcrypt.compare(body.password, account.password_hash);
        await authDb.query('SELECT app_record_login_attempt($1, $2, $3)', [account.email, ip, match]);
        if (!match) {
          return res.status(401).json({ error: 'That password is not correct.' });
        }

        await db.as({ role: account.role, userId: account.id }).query(
          'INSERT INTO user_google_identities (id, google_sub, user_id, email) VALUES ($1, $2, $3, $4)',
          [newId('gid'), claims.sub, account.id, claims.email]
        );
        return await signIn(res, account);
      }

      if (!body.role) {
        return res.json({ status: 'needs_registration', email: claims.email, name: claims.name ?? null });
      }

      const displayName = body.role === 'shipper' ? body.company_name || body.name : body.name;
      if (!displayName) {
        return res.status(400).json({
          error: body.role === 'shipper' ? 'Enter the company name.' : 'Enter your full name.'
        });
      }

      // The same limit as password signup: a Google account is no cheaper a way
      // to mint accounts from one network.
      const signupLimit = await rateLimitHit(db, `signup:${ip}`, 5, 3600);
      if (signupLimit && !signupLimit.allowed) {
        res.setHeader('Retry-After', String(signupLimit.retry_after || 3600));
        return res.status(429).json({
          error: 'Too many signups from this network. Try again in an hour.',
          retry_after_seconds: signupLimit.retry_after
        });
      }

      const created = await db.transaction(async tx => {
        const rows = await createAccountRows(tx, {
          email: claims.email,
          role: body.role!,
          name: displayName,
          passwordHash: null,
          phone: body.phone,
          homeCity: body.home_city,
          homeState: body.home_state,
          companyName: body.company_name
        });
        await tx.query(
          'INSERT INTO user_google_identities (id, google_sub, user_id, email) VALUES ($1, $2, $3, $4)',
          [newId('gid'), claims.sub, rows.userId, claims.email]
        );
        return rows;
      }, { role: 'enrollment' });

      const session = {
        id: created.userId,
        email: claims.email,
        role: body.role,
        driverId: created.driverId,
        shipperId: created.shipperId
      };
      return res.json({
        status: 'created',
        token: generateToken(session),
        user: { ...session, name: displayName }
      });
    } catch (err: any) {
      if (err instanceof GoogleTokenError) {
        return res.status(err.status).json({ error: err.message });
      }
      // Two tabs racing on the same login hit the unique constraints.
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'This account was just set up. Try signing in again.' });
      }
      console.error('[AUTH] Google sign-in failed:', err);
      return res.status(500).json({ error: 'Google sign-in failed. Try again.' });
    }
  };
}
