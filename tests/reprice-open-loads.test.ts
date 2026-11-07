/**
 * Migration 0027 takes the 7% adder out of open loads that are still at their
 * quoted rate, and touches nothing else. Run with: npm test
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { after, before, test } from 'node:test';
import { createMigratedDatabase, MIGRATIONS_DIR, type Harness } from './helpers/migration-harness';

let h: Harness;
const REPRICE = fs.readFileSync(path.join(MIGRATIONS_DIR, '0027_reprice_open_quoted_loads.sql'), 'utf-8');

interface Seed {
  id: string;
  status?: string;
  miles?: number;
  rate: number;
  afterExpress?: number;
  floor?: number;
  markup?: number;
  overridden?: boolean;
  loggedRate?: number;
}

async function addQuotedLoad(s: Seed): Promise<void> {
  const miles = s.miles ?? 1000;
  await h.pg.query(
    `INSERT INTO loads (id, shipper_id, origin_city, origin_state, dest_city, dest_state, miles, rate_per_mile, pickup_date, status)
     VALUES ($1, 'shp-1', 'Dallas', 'TX', 'Atlanta', 'GA', $2, $3, '2026-11-04', $4)`,
    [s.id, miles, s.rate, s.status ?? 'open']
  );
  const breakdown = {
    after_express: s.afterExpress ?? 2000,
    minimum_floor: s.floor ?? 500,
    gross_markup: s.markup ?? 140
  };
  await h.pg.query(
    `INSERT INTO rate_quotes (id, equipment_key, load_id, miles, demand_multiplier, breakdown, quoted_total, quoted_rate_per_mile, overridden, posted_rate_per_mile)
     VALUES ($1, 'dry_van', $2, $3, 1, $4::jsonb, $5, $6, $7, $8)`,
    [`QT-${s.id}`, s.id, miles, JSON.stringify(breakdown), s.rate * miles, s.rate, s.overridden ?? false, s.loggedRate ?? s.rate]
  );
}

async function rateOf(id: string): Promise<number> {
  const res = await h.pg.query<{ rate_per_mile: string }>('SELECT rate_per_mile FROM loads WHERE id = $1', [id]);
  return Number(res.rows[0].rate_per_mile);
}

before(async () => {
  h = await createMigratedDatabase();
  const hash = `$2b$10$${'a'.repeat(53)}`;
  await h.pg.exec(`
    INSERT INTO users (id, role, email, password_hash) VALUES ('usr-s', 'shipper', 's@example.com', '${hash}');
    INSERT INTO shipper_profiles (id, user_id, company_name, billing_email) VALUES ('shp-1', 'usr-s', 'S Foods', 's@example.com');
  `);

  await addQuotedLoad({ id: 'LD-quoted', rate: 2.14 });
  await addQuotedLoad({ id: 'LD-floored', miles: 100, rate: 5.35, afterExpress: 450, markup: 31.5 });
  await addQuotedLoad({ id: 'LD-override', rate: 3, overridden: true });
  await addQuotedLoad({ id: 'LD-booked', rate: 2.14, status: 'booked' });
  await addQuotedLoad({ id: 'LD-edited', rate: 2.5, loggedRate: 2.14 });
  await addQuotedLoad({ id: 'LD-no-adder', rate: 2, markup: 0 });

  await h.pg.exec(REPRICE);
});

after(() => h.destroy());

test('an open load at its quoted rate loses the adder', async () => {
  assert.equal(await rateOf('LD-quoted'), 2);
});

test('the distance minimum still floors a repriced load', async () => {
  assert.equal(await rateOf('LD-floored'), 5);
});

test('shipper-set, booked, edited, and adder-free loads keep their rate', async () => {
  assert.equal(await rateOf('LD-override'), 3);
  assert.equal(await rateOf('LD-booked'), 2.14);
  assert.equal(await rateOf('LD-edited'), 2.5);
  assert.equal(await rateOf('LD-no-adder'), 2);
});

test('the logged quote keeps what was originally quoted', async () => {
  const res = await h.pg.query<{ posted_rate_per_mile: string }>(
    `SELECT posted_rate_per_mile FROM rate_quotes WHERE id = 'QT-LD-quoted'`
  );
  assert.equal(Number(res.rows[0].posted_rate_per_mile), 2.14);
});
