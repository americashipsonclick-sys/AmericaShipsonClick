/**
 * Freight photo rules from migration 0024, exercised as the app's database role
 * so Row-Level Security applies. Run with: npm test
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createMigratedDatabase, type Harness } from './helpers/migration-harness';

let h: Harness;
const PIXEL = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

interface Who {
  role: string;
  shipperId?: string;
  driverId?: string;
}

/** Runs one statement as asoc_app with a request's session context. */
async function as<T = any>(who: Who, sql: string, params: unknown[] = []): Promise<T[]> {
  return h.pg.transaction(async tx => {
    await tx.query(
      `SELECT set_config('app.user_role', $1, true), set_config('app.user_id', 'usr-test', true),
              set_config('app.driver_id', $2, true), set_config('app.shipper_id', $3, true)`,
      [who.role, who.driverId ?? '', who.shipperId ?? '']
    );
    await tx.exec('SET LOCAL ROLE asoc_app');
    const res = await tx.query<T>(sql, params);
    return res.rows;
  });
}

let photoSeq = 0;
function addPhoto(who: Who, loadId: string) {
  photoSeq += 1;
  return as(who, 'SELECT app_add_load_photo($1, $2, $3, $4, $5, $6)', [
    `PH-${photoSeq}`, `doc-${photoSeq}`, loadId, 'image/jpeg', PIXEL, null
  ]);
}

const SHIPPER_A: Who = { role: 'shipper', shipperId: 'shp-a' };
const SHIPPER_B: Who = { role: 'shipper', shipperId: 'shp-b' };
const DRIVER_1: Who = { role: 'driver', driverId: 'drv-1' };
const DRIVER_2: Who = { role: 'driver', driverId: 'drv-2' };

before(async () => {
  h = await createMigratedDatabase();
  const hash = `$2b$10$${'a'.repeat(53)}`;
  await h.pg.exec(`
    INSERT INTO users (id, role, email, password_hash) VALUES
      ('usr-a', 'shipper', 'a@example.com', '${hash}'), ('usr-b', 'shipper', 'b@example.com', '${hash}'),
      ('usr-1', 'driver', 'one@example.com', '${hash}'), ('usr-2', 'driver', 'two@example.com', '${hash}');
    INSERT INTO shipper_profiles (id, user_id, company_name, billing_email) VALUES
      ('shp-a', 'usr-a', 'A Foods', 'a@example.com'), ('shp-b', 'usr-b', 'B Foods', 'b@example.com');
    INSERT INTO driver_profiles (id, user_id, full_name, home_base_city, home_base_state) VALUES
      ('drv-1', 'usr-1', 'One', 'Dallas', 'TX'),
      ('drv-2', 'usr-2', 'Two', 'Dallas', 'TX');
    INSERT INTO loads (id, shipper_id, origin_city, origin_state, dest_city, dest_state, miles, rate_per_mile, pickup_date) VALUES
      ('LD-open', 'shp-a', 'Temple', 'TX', 'Pittsboro', 'NC', 1212, 3, '2026-11-04'),
      ('LD-limit', 'shp-a', 'Temple', 'TX', 'Pittsboro', 'NC', 1212, 3, '2026-11-04'),
      ('LD-booked', 'shp-a', 'Temple', 'TX', 'Pittsboro', 'NC', 1212, 3, '2026-11-04');
  `);
  await addPhoto(SHIPPER_A, 'LD-open');
  await addPhoto(SHIPPER_A, 'LD-booked');
  await h.pg.exec(`
    INSERT INTO bookings (id, load_id, driver_id, status) VALUES ('BK-1', 'LD-booked', 'drv-1', 'active');
    UPDATE loads SET status = 'booked' WHERE id = 'LD-booked';
  `);
});

after(async () => {
  await h?.destroy();
});

test('a shipper cannot add a photo to another shipper\'s load', async () => {
  await assert.rejects(addPhoto(SHIPPER_B, 'LD-open'), /Load not found/);
});

test('a driver cannot add a photo', async () => {
  await assert.rejects(addPhoto(DRIVER_1, 'LD-open'), /Load not found/);
});

test('a load holds at most three photos', async () => {
  await addPhoto(SHIPPER_A, 'LD-limit');
  await addPhoto(SHIPPER_A, 'LD-limit');
  await addPhoto(SHIPPER_A, 'LD-limit');
  await assert.rejects(addPhoto(SHIPPER_A, 'LD-limit'), /at most 3 photos/);
});

test('photos are frozen once the load is booked', async () => {
  await assert.rejects(addPhoto(SHIPPER_A, 'LD-booked'), /while the load is open/);
});

const photosOn = (who: Who, loadId: string) =>
  as(who, 'SELECT id FROM load_photos WHERE load_id = $1', [loadId]);

test('RLS: any driver sees photos on an open load; other shippers do not', async () => {
  assert.equal((await photosOn(DRIVER_2, 'LD-open')).length, 1);
  assert.equal((await photosOn(SHIPPER_A, 'LD-open')).length, 1);
  assert.equal((await photosOn(SHIPPER_B, 'LD-open')).length, 0);
  assert.equal((await photosOn({ role: 'anon' }, 'LD-open')).length, 0);
});

test('RLS: on a booked load only the booked driver still sees photos', async () => {
  assert.equal((await photosOn(DRIVER_1, 'LD-booked')).length, 1);
  assert.equal((await photosOn(DRIVER_2, 'LD-booked')).length, 0);
});

test('the app role cannot write load_photos directly', async () => {
  await assert.rejects(as(SHIPPER_A, `DELETE FROM load_photos WHERE load_id = 'LD-open'`), /permission denied/);
});

test('removing a photo removes its stored file', async () => {
  const [photo] = await as<{ id: string }>(SHIPPER_A, `SELECT id FROM load_photos WHERE load_id = 'LD-open'`);
  await assert.rejects(as(SHIPPER_B, 'SELECT app_remove_load_photo($1, $2)', [photo.id, 'LD-open']), /Load not found/);

  const before = await h.pg.query<{ file_id: string }>('SELECT file_id FROM load_photos WHERE id = $1', [photo.id]);
  await as(SHIPPER_A, 'SELECT app_remove_load_photo($1, $2)', [photo.id, 'LD-open']);
  const file = await h.pg.query('SELECT 1 FROM uploaded_files WHERE id = $1', [before.rows[0].file_id]);
  assert.equal(file.rows.length, 0);
});

test('the public shipper view exposes no billing contact', async () => {
  const [row] = await as<Record<string, unknown>>({ role: 'anon' }, `SELECT * FROM public_shipper_view WHERE id = 'shp-a'`);
  assert.deepEqual(Object.keys(row).sort(), ['company_name', 'id', 'loads_posted', 'member_since']);
  assert.equal(row.loads_posted, 3);
});
