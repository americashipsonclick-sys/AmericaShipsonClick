/**
 * Migration 0025: new settlements carry no platform fee, and rows charged one
 * still balance. Run with: npm test
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createMigratedDatabase, type Harness } from './helpers/migration-harness';

let h: Harness;

before(async () => {
  h = await createMigratedDatabase();
  const hash = `$2b$10$${'a'.repeat(53)}`;
  await h.pg.exec(`
    INSERT INTO users (id, role, email, password_hash) VALUES
      ('usr-s', 'shipper', 's@example.com', '${hash}'), ('usr-d', 'driver', 'd@example.com', '${hash}');
    INSERT INTO shipper_profiles (id, user_id, company_name, billing_email) VALUES
      ('shp-1', 'usr-s', 'S Foods', 's@example.com');
    INSERT INTO driver_profiles (id, user_id, full_name, home_base_city, home_base_state) VALUES
      ('drv-1', 'usr-d', 'One', 'Dallas', 'TX');
  `);
});

after(() => h.destroy());

async function addBooking(n: number): Promise<void> {
  await h.pg.query(
    `INSERT INTO loads (id, shipper_id, origin_city, origin_state, dest_city, dest_state, miles, rate_per_mile, pickup_date)
     VALUES ($1, 'shp-1', 'Dallas', 'TX', 'Atlanta', 'GA', 780, 2.15, '2026-11-04')`,
    [`LD-${n}`]
  );
  await h.pg.query(
    `INSERT INTO bookings (id, load_id, driver_id, status) VALUES ($1, $2, 'drv-1', 'completed')`,
    [`BK-${n}`, `LD-${n}`]
  );
}

test('the fee rate and the quote adder are gone', async () => {
  const rows = await h.pg.query<{ key: string }>('SELECT key FROM platform_config');
  const keys = rows.rows.map(r => r.key);
  assert.ok(!keys.includes('fee_pct'));
  assert.ok(!keys.includes('quote_gross_pct'));
  assert.ok(keys.includes('factor_pct'));
});

test('a settlement written without a fee records zero and pays the full gross', async () => {
  await addBooking(1);
  const gross = 780 * 2.15;
  await h.pg.query(
    `INSERT INTO settlements (id, booking_id, load_id, miles, rate_per_mile, gross_amount, factor_cost, factored, net_amount, settled_at)
     VALUES ('STL-1', 'BK-1', 'LD-1', 780, 2.15, $1, 0, FALSE, $2, CURRENT_TIMESTAMP)`,
    [gross, gross]
  );
  const res = await h.pg.query<{ fee_amount: string; fee_pct_applied: string; net_amount: string }>(
    `SELECT fee_amount, fee_pct_applied, net_amount FROM settlements WHERE id = 'STL-1'`
  );
  assert.equal(Number(res.rows[0].fee_amount), 0);
  assert.equal(Number(res.rows[0].fee_pct_applied), 0);
  assert.ok(Math.abs(Number(res.rows[0].net_amount) - 1677) < 0.001);
});

test('a row that charged a fee still has to balance', async () => {
  await addBooking(2);
  const insert = (net: number) =>
    h.pg.query(
      `INSERT INTO settlements (id, booking_id, load_id, miles, rate_per_mile, gross_amount, fee_amount, fee_pct_applied, factor_cost, factored, net_amount, settled_at)
       VALUES ('STL-2', 'BK-2', 'LD-2', 780, 2.15, 1677, 117.39, 0.07, 0, FALSE, $1, CURRENT_TIMESTAMP)`,
      [net]
    );
  await assert.rejects(insert(1677), /settlements_math_balances/);
  await insert(1559.61);
});
