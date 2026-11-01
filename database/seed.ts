/**
 * Demo data seeding.
 *
 * Runs once against an empty database: demo accounts (driver / shipper / admin),
 * a board of open loads, and historical settlements so "Open Books" has a
 * ledger to render. Everything runs in one transaction and every insert is
 * `ON CONFLICT DO NOTHING`, so a re-run is a no-op rather than a duplicate.
 */
import bcrypt from 'bcryptjs';
import type { Database, Queryable } from './client';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'password123';

export async function isDatabaseEmpty(db: Database): Promise<boolean> {
  const res = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
  return parseInt(res.rows[0]?.count ?? '0', 10) === 0;
}

/**
 * Seeding is on by default in development. In production it requires an
 * explicit opt-in, since these are known-password demo accounts.
 */
export function seedingEnabled(): boolean {
  const flag = (process.env.DB_SEED || '').trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'always') return true;
  if (flag === 'false' || flag === '0' || flag === 'never') return false;
  return process.env.NODE_ENV !== 'production';
}

export async function seedDatabase(db: Database): Promise<void> {
  console.log('[DB] Seeding synthetic lane & load data...');
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  // Runs as the owner role (which RLS does not restrict); the 'admin' context
  // is set so the audit trail attributes these rows to seeding rather than to
  // an anonymous actor.
  await db.transaction(async tx => {
    await seedUsers(tx, passwordHash);
    await seedOpenLoads(tx);
    await seedHistoricalSettlements(tx);
  }, { role: 'admin', userId: 'seed' });

  console.log('[DB] Seeding completed.');
}

async function seedUsers(tx: Queryable, passwordHash: string): Promise<void> {
  // 1. Admin User
  await tx.query(`
    INSERT INTO users (id, role, email, phone, password_hash)
    VALUES ('usr-admin-1', 'admin', 'admin@americashipsonclick.com', '18005550100', $1)
    ON CONFLICT DO NOTHING
  `, [passwordHash]);

  // 2. Shipper User & Profile
  await tx.query(`
    INSERT INTO users (id, role, email, phone, password_hash)
    VALUES ('usr-shipper-1', 'shipper', 'logistics@apexlogistics.com', '18005550199', $1)
    ON CONFLICT DO NOTHING
  `, [passwordHash]);

  await tx.query(`
    INSERT INTO shipper_profiles (id, user_id, company_name, billing_email)
    VALUES ('shp-001', 'usr-shipper-1', 'Apex Freight Corp', 'billing@apexlogistics.com')
    ON CONFLICT DO NOTHING
  `);

  // 3. Driver Users, Profiles, Equipment, Payment Accounts
  const drivers = [
    {
      userId: 'usr-driver-1',
      driverId: 'drv-001',
      email: 'john.smith@trucking.com',
      name: 'John Smith',
      city: 'Joplin',
      state: 'MO',
      cdl: 'CDL-998811',
      dot: 'DOT-33211',
      mc: 'MC-77112',
      equip: 'dry_van',
      processorAcct: 'acct_stripe_dr1_tokenized'
    },
    {
      userId: 'usr-driver-2',
      driverId: 'drv-002',
      email: 'maria.garcia@expedited.com',
      name: 'Maria Garcia',
      city: 'Dallas',
      state: 'TX',
      cdl: 'CDL-441199',
      dot: 'DOT-88123',
      mc: 'MC-55991',
      equip: 'reefer',
      processorAcct: 'acct_stripe_dr2_tokenized'
    }
  ];

  for (const d of drivers) {
    await tx.query(`
      INSERT INTO users (id, role, email, phone, password_hash)
      VALUES ($1, 'driver', $2, '18005550122', $3)
      ON CONFLICT DO NOTHING
    `, [d.userId, d.email, passwordHash]);

    await tx.query(`
      INSERT INTO driver_profiles (id, user_id, full_name, home_base_city, home_base_state, cdl_number, cdl_class, dot_number, mc_number, verification_status)
      VALUES ($1, $2, $3, $4, $5, $6, 'A', $7, $8, 'verified')
      ON CONFLICT DO NOTHING
    `, [d.driverId, d.userId, d.name, d.city, d.state, d.cdl, d.dot, d.mc]);

    await tx.query(`
      INSERT INTO driver_equipment (id, driver_id, equipment_type, trailer_length_ft)
      VALUES ($1, $2, $3, 53)
      ON CONFLICT DO NOTHING
    `, ['eq-' + d.driverId, d.driverId, d.equip]);

    await tx.query(`
      INSERT INTO driver_payment_accounts (id, driver_id, payment_processor, processor_account_id, same_day_funding_opt_in)
      VALUES ($1, $2, 'stripe_connect', $3, TRUE)
      ON CONFLICT DO NOTHING
    `, ['pay-' + d.driverId, d.driverId, d.processorAcct]);
  }
}

async function seedOpenLoads(tx: Queryable): Promise<void> {
  const initialLoads = [
    { id: 'LD-1042', origin_city: 'Dallas', origin_state: 'TX', origin_lat: 32.7767, origin_lng: -96.7970, dest_city: 'Atlanta', dest_state: 'GA', dest_lat: 33.7490, dest_lng: -84.3880, miles: 780, rate: 2.15, equip: 'dry_van', pickup: '2026-08-04', weight: 41900, notes: '26 pallets non-hazmat' },
    { id: 'LD-1043', origin_city: 'Chicago', origin_state: 'IL', origin_lat: 41.8781, origin_lng: -87.6298, dest_city: 'Memphis', dest_state: 'TN', dest_lat: 35.1495, dest_lng: -90.0490, miles: 530, rate: 2.45, equip: 'reefer', pickup: '2026-08-03', weight: 38200, notes: 'Continuous temp 34F' },
    { id: 'LD-1044', origin_city: 'Los Angeles', origin_state: 'CA', origin_lat: 34.0522, origin_lng: -118.2437, dest_city: 'Phoenix', dest_state: 'AZ', dest_lat: 33.4484, dest_lng: -112.0740, miles: 370, rate: 2.90, equip: 'flatbed', pickup: '2026-08-05', weight: 44000, notes: 'Straps and tarp required' },
    { id: 'LD-1045', origin_city: 'Laredo', origin_state: 'TX', origin_lat: 27.5306, origin_lng: -99.4803, dest_city: 'Chicago', dest_state: 'IL', dest_lat: 41.8781, dest_lng: -87.6298, miles: 1240, rate: 2.20, equip: 'dry_van', pickup: '2026-08-06', weight: 40000, notes: 'Clean trailer required' },
    { id: 'LD-1046', origin_city: 'Charlotte', origin_state: 'NC', origin_lat: 35.2271, origin_lng: -80.8431, dest_city: 'Miami', dest_state: 'FL', dest_lat: 25.7617, dest_lng: -80.1918, miles: 650, rate: 2.35, equip: 'reefer', pickup: '2026-08-04', weight: 36500, notes: 'Pre-cooled to 36F' },
    { id: 'LD-1047', origin_city: 'Columbus', origin_state: 'OH', origin_lat: 39.9612, origin_lng: -82.9988, dest_city: 'Newark', dest_state: 'NJ', dest_lat: 40.7357, dest_lng: -74.1724, miles: 530, rate: 2.60, equip: 'step_deck', pickup: '2026-08-07', weight: 42800, notes: 'Overheight machinery' },
    { id: 'LD-1048', origin_city: 'Seattle', origin_state: 'WA', origin_lat: 47.6062, origin_lng: -122.3321, dest_city: 'Denver', dest_state: 'CO', dest_lat: 39.7392, dest_lng: -104.9903, miles: 1020, rate: 2.30, equip: 'dry_van', pickup: '2026-08-05', weight: 39600, notes: 'No hazmat' },
    { id: 'LD-1049', origin_city: 'Houston', origin_state: 'TX', origin_lat: 29.7604, origin_lng: -95.3698, dest_city: 'Nashville', dest_state: 'TN', dest_lat: 36.1627, dest_lng: -86.7816, miles: 780, rate: 2.50, equip: 'flatbed', pickup: '2026-08-06', weight: 45000, notes: 'Steel coils' },
    { id: 'LD-1050', origin_city: 'Indianapolis', origin_state: 'IN', origin_lat: 39.7684, origin_lng: -86.1581, dest_city: 'Kansas City', dest_state: 'MO', dest_lat: 39.0997, dest_lng: -94.5786, miles: 490, rate: 2.75, equip: 'power_only', pickup: '2026-08-03', weight: 0, notes: 'Pre-loaded trailer drop' },
    { id: 'LD-1051', origin_city: 'Savannah', origin_state: 'GA', origin_lat: 32.0809, origin_lng: -81.0912, dest_city: 'Charlotte', dest_state: 'NC', dest_lat: 35.2271, dest_lng: -80.8431, miles: 260, rate: 3.05, equip: 'dry_van', pickup: '2026-08-04', weight: 37100, notes: 'Port pickup' },
    { id: 'LD-1052', origin_city: 'Ontario', origin_state: 'CA', origin_lat: 34.0633, origin_lng: -117.6509, dest_city: 'Salt Lake City', dest_state: 'UT', dest_lat: 40.7608, dest_lng: -111.8910, miles: 700, rate: 2.20, equip: 'reefer', pickup: '2026-08-08', weight: 40900, notes: 'Frozen food -10F' },
    { id: 'LD-1053', origin_city: 'Harrisburg', origin_state: 'PA', origin_lat: 40.2732, origin_lng: -76.8867, dest_city: 'Boston', dest_state: 'MA', dest_lat: 42.3601, dest_lng: -71.0589, miles: 370, rate: 2.65, equip: 'dry_van', pickup: '2026-08-05', weight: 41200, notes: 'Live load' }
  ];

  for (const l of initialLoads) {
    await tx.query(`
      INSERT INTO loads (
        id, shipper_id, origin_city, origin_state, dest_city, dest_state,
        origin_lat, origin_lng, dest_lat, dest_lng,
        miles, rate_per_mile, equipment_type, pickup_date, weight_lbs, notes, same_day_funding_offered, status
      )
      VALUES ($1, 'shp-001', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, 'open')
      ON CONFLICT DO NOTHING
    `, [l.id, l.origin_city, l.origin_state, l.dest_city, l.dest_state, l.origin_lat, l.origin_lng, l.dest_lat, l.dest_lng, l.miles, l.rate, l.equip, l.pickup, l.weight, l.notes]);
  }
}

async function seedHistoricalSettlements(tx: Queryable): Promise<void> {
  const historicalLanes = [
    { from: 'Dallas, TX', to: 'Atlanta, GA', miles: 780, equip: 'dry_van' },
    { from: 'Chicago, IL', to: 'Memphis, TN', miles: 530, equip: 'reefer' },
    { from: 'Los Angeles, CA', to: 'Phoenix, AZ', miles: 370, equip: 'flatbed' },
    { from: 'Laredo, TX', to: 'Chicago, IL', miles: 1240, equip: 'dry_van' },
    { from: 'Charlotte, NC', to: 'Miami, FL', miles: 650, equip: 'reefer' },
    { from: 'Columbus, OH', to: 'Newark, NJ', miles: 530, equip: 'step_deck' },
    { from: 'Seattle, WA', to: 'Denver, CO', miles: 1020, equip: 'dry_van' },
    { from: 'Houston, TX', to: 'Nashville, TN', miles: 780, equip: 'flatbed' },
    { from: 'Indianapolis, IN', to: 'Kansas City, MO', miles: 490, equip: 'power_only' },
    { from: 'Savannah, GA', to: 'Charlotte, NC', miles: 260, equip: 'dry_van' },
    { from: 'Ontario, CA', to: 'Salt Lake City, UT', miles: 700, equip: 'reefer' },
    { from: 'Harrisburg, PA', to: 'Boston, MA', miles: 370, equip: 'dry_van' }
  ];

  // Seed math mirrors the platform_config rows the migrations set.
  const cfgRes = await tx.query<{ key: string; value: string }>('SELECT key, value FROM platform_config');
  const cfg: Record<string, number> = {};
  cfgRes.rows.forEach(r => (cfg[r.key] = parseFloat(r.value)));

  const feePct = cfg['fee_pct'] ?? 0.07;
  const factorPct = cfg['factor_pct'] ?? 0.03;
  const fuelRate = cfg['fuel_rate_per_mile'] ?? 0.45;

  for (let i = 1; i <= 18; i++) {
    const lane = historicalLanes[(i - 1) % historicalLanes.length];
    const [fromCity, fromState] = lane.from.split(', ');
    const [toCity, toState] = lane.to.split(', ');
    const loadId = `LD-HIST-${String(i).padStart(4, '0')}`;
    const bookingId = `BK-HIST-${String(i).padStart(4, '0')}`;
    const settlementId = `STL-${String(i).padStart(5, '0')}`;

    const miles = lane.miles;
    const ratePerMile = +(2.05 + Math.random() * 1.1).toFixed(2);
    const gross = miles * ratePerMile;
    const feeAmount = gross * feePct;
    const fuelCost = miles * fuelRate;
    const factored = i % 3 === 0;
    const factorCost = factored ? gross * factorPct : 0;
    const net = gross - feeAmount - fuelCost - factorCost;

    const daysAgo = 18 - i;
    const settledAt = new Date(Date.now() - daysAgo * 3600 * 1000 * 12 - Math.random() * 3600000).toISOString();

    await tx.query(`
      INSERT INTO loads (id, shipper_id, origin_city, origin_state, dest_city, dest_state, miles, rate_per_mile, equipment_type, pickup_date, status)
      VALUES ($1, 'shp-001', $2, $3, $4, $5, $6, $7, $8, '2026-07-20', 'delivered')
      ON CONFLICT DO NOTHING
    `, [loadId, fromCity, fromState, toCity, toState, miles, ratePerMile, lane.equip]);

    await tx.query(`
      INSERT INTO bookings (id, load_id, driver_id, status, delivered_at)
      VALUES ($1, $2, 'drv-001', 'completed', $3)
      ON CONFLICT DO NOTHING
    `, [bookingId, loadId, settledAt]);

    await tx.query(`
      INSERT INTO settlements (
        id, booking_id, load_id, miles, rate_per_mile, fuel_rate_per_mile,
        gross_amount, fee_amount, fee_pct_applied, fuel_cost, factor_cost, factored, net_amount, settled_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING
    `, [
      settlementId, bookingId, loadId, miles, ratePerMile, fuelRate,
      gross, feeAmount, feePct, fuelCost, factorCost, factored, net, settledAt
    ]);
  }
}
