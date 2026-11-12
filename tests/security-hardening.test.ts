/**
 * Migration 0028 (login lockout scope, private uploads) and the client-address
 * rule in backend/security.ts. Run with: npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { clientIp, trustedProxyHops } from '../backend/security';
import { createMigratedDatabase, type Harness } from './helpers/migration-harness';

let h: Harness;

interface Who {
  role: string;
  userId?: string;
}

/** Runs one statement as asoc_app with a request's session context. */
async function as<T = any>(who: Who, sql: string, params: unknown[] = []): Promise<T[]> {
  return h.pg.transaction(async tx => {
    await tx.query(
      `SELECT set_config('app.user_role', $1, true), set_config('app.user_id', $2, true)`,
      [who.role, who.userId ?? '']
    );
    await tx.exec('SET LOCAL ROLE asoc_app');
    const res = await tx.query<T>(sql, params);
    return res.rows;
  });
}

const AUTH: Who = { role: 'auth' };

async function fail(email: string, ip: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await as(AUTH, 'SELECT app_record_login_attempt($1, $2, FALSE)', [email, ip]);
  }
}

async function lockedFor(email: string, ip: string): Promise<number> {
  const rows = await as<{ seconds: number }>(AUTH, 'SELECT app_login_lockout_seconds($1, $2) AS seconds', [email, ip]);
  return Number(rows[0].seconds);
}

before(async () => {
  h = await createMigratedDatabase();
});

after(async () => {
  await h?.destroy();
});

beforeEach(async () => {
  await h.pg.exec('DELETE FROM auth_login_attempts');
});

// --- Login lockout ----------------------------------------------------------

test('five wrong passwords lock that address out of that account', async () => {
  await fail('victim@example.com', '203.0.113.9', 4);
  assert.equal(await lockedFor('victim@example.com', '203.0.113.9'), 0);
  await fail('victim@example.com', '203.0.113.9', 1);
  const seconds = await lockedFor('victim@example.com', '203.0.113.9');
  assert.ok(seconds > 0 && seconds <= 900, `expected a lockout within 15 minutes, got ${seconds}`);
});

test('someone else\'s wrong guesses do not lock the owner out', async () => {
  await fail('victim@example.com', '203.0.113.9', 5);
  assert.equal(await lockedFor('victim@example.com', '198.51.100.20'), 0);
});

test('an address walking many accounts is stopped after twenty failures', async () => {
  for (let i = 0; i < 20; i += 1) {
    await fail(`user${i}@example.com`, '203.0.113.9', 1);
  }
  assert.ok(await lockedFor('untouched@example.com', '203.0.113.9') > 0);
  assert.equal(await lockedFor('untouched@example.com', '198.51.100.20'), 0);
});

test('fifty failures from many addresses lock the account for everyone', async () => {
  for (let i = 0; i < 49; i += 1) {
    await fail('victim@example.com', `198.51.100.${i}`, 1);
  }
  assert.equal(await lockedFor('victim@example.com', '192.0.2.1'), 0);
  await fail('victim@example.com', '198.51.100.200', 1);
  assert.ok(await lockedFor('victim@example.com', '192.0.2.1') > 0);
});

test('a successful sign-in clears the account\'s failure streak', async () => {
  await fail('victim@example.com', '203.0.113.9', 5);
  await as(AUTH, 'SELECT app_record_login_attempt($1, $2, TRUE)', ['victim@example.com', '198.51.100.20']);
  assert.equal(await lockedFor('victim@example.com', '203.0.113.9'), 0);
});

// --- Private uploads --------------------------------------------------------

const PDF = Buffer.from('%PDF-1.4');
const DRIVER: Who = { role: 'driver', userId: 'usr-driver' };

async function readUpload(who: Who, id: string) {
  return as<{ content_type: string }>(who, 'SELECT content_type FROM app_get_own_upload($1)', [id]);
}

test('an uploaded document is readable by its uploader and by an admin only', async () => {
  await as(DRIVER, 'SELECT app_store_upload($1, $2, $3)', ['doc-cdl', 'application/pdf', PDF]);

  assert.equal((await readUpload(DRIVER, 'doc-cdl')).length, 1);
  assert.equal((await readUpload({ role: 'admin', userId: 'usr-admin' }, 'doc-cdl')).length, 1);

  assert.equal((await readUpload({ role: 'driver', userId: 'usr-other' }, 'doc-cdl')).length, 0);
  assert.equal((await readUpload({ role: 'shipper', userId: 'usr-shipper' }, 'doc-cdl')).length, 0);
  assert.equal((await readUpload({ role: 'anon' }, 'doc-cdl')).length, 0);
});

test('a caller with no user id never matches a file with no recorded uploader', async () => {
  await h.pg.query(
    `INSERT INTO uploaded_files (id, content_type, size_bytes, data, uploaded_by) VALUES ('doc-legacy', 'application/pdf', 8, $1, NULL)`,
    [PDF]
  );
  assert.equal((await readUpload({ role: 'anon' }, 'doc-legacy')).length, 0);
  assert.equal((await readUpload({ role: 'driver' }, 'doc-legacy')).length, 0);
});

// --- Client address ---------------------------------------------------------

/** Asks a real Express app, configured the way server.ts configures it, who the caller is. */
async function addressSeen(env: Record<string, string>, headers: Record<string, string>): Promise<string> {
  const saved = { TRUST_PROXY: process.env.TRUST_PROXY, CLIENT_IP_HEADER: process.env.CLIENT_IP_HEADER };
  delete process.env.TRUST_PROXY;
  delete process.env.CLIENT_IP_HEADER;
  Object.assign(process.env, env);

  const app = express();
  const hops = trustedProxyHops();
  if (hops > 0) app.set('trust proxy', hops);
  app.get('/', (req, res) => { res.send(clientIp(req)); });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers });
    return await res.text();
  } finally {
    server.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('with no trusted proxy, forwarding headers are ignored', async () => {
  const seen = await addressSeen({}, { 'X-Forwarded-For': '1.2.3.4', 'CF-Connecting-IP': '5.6.7.8' });
  assert.match(seen, /127\.0\.0\.1$/);

  const withHeaderOnly = await addressSeen({ CLIENT_IP_HEADER: 'cf-connecting-ip' }, { 'CF-Connecting-IP': '5.6.7.8' });
  assert.match(withHeaderOnly, /127\.0\.0\.1$/);
});

test('a made-up first X-Forwarded-For entry does not become the client address', async () => {
  const seen = await addressSeen({ TRUST_PROXY: 'true' }, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.9' });
  assert.equal(seen, '203.0.113.9');
});

test('the hop count picks the entry that many proxies back', async () => {
  const seen = await addressSeen({ TRUST_PROXY: '2' }, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.9, 172.70.0.1' });
  assert.equal(seen, '203.0.113.9');
});

test('the configured edge header wins, unless it is not an address', async () => {
  const env = { TRUST_PROXY: 'true', CLIENT_IP_HEADER: 'cf-connecting-ip' };
  assert.equal(
    await addressSeen(env, { 'CF-Connecting-IP': '198.51.100.20', 'X-Forwarded-For': '1.2.3.4, 203.0.113.9' }),
    '198.51.100.20'
  );
  assert.equal(
    await addressSeen(env, { 'CF-Connecting-IP': 'not-an-address', 'X-Forwarded-For': '1.2.3.4, 203.0.113.9' }),
    '203.0.113.9'
  );
});
