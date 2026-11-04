/**
 * What Continue with Google changes for the password routes, through the real
 * router. The router's database is the file-backed dev engine, so this points it
 * at a temp directory and imports it afterwards. Run with: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';

let server: Server;
let baseUrl: string;
let closeDb: () => Promise<void>;
const repoDir = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asoc-routes-'));

const send = async (route: string, body: unknown) => {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: (await res.json()) as any };
};

before(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_ADMIN_URL;
  delete process.env.ADMIN_PASSWORD;
  process.env.MIGRATIONS_DIR = path.join(repoDir, 'database', 'migrations');
  process.env.DB_SEED = 'false';
  process.env.JWT_SECRET = 'test-secret-long-enough-for-this-suite';
  delete process.env.GOOGLE_CLIENT_ID;
  process.chdir(tempDir);

  const database = await import('../database');
  closeDb = database.closeDb;
  await database.initDb();
  await database.db.exec(`
    INSERT INTO users (id, role, email, password_hash) VALUES ('usr-google', 'driver', 'google.only@example.com', NULL);
    INSERT INTO driver_profiles (id, user_id, full_name, home_base_city, home_base_state)
      VALUES ('drv-google', 'usr-google', 'Google Only', 'Dallas', 'TX');
  `);

  const { apiRouter } = await import('../backend/routes');
  const app = express();
  app.use(express.json());
  app.use(apiRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise(resolve => server?.close(resolve));
  await closeDb?.();
  process.chdir(repoDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('password login on a Google-only account fails like any wrong password', async () => {
  const google = await send('/auth/login', { email: 'google.only@example.com', password: 'anything-at-all' });
  const unknown = await send('/auth/login', { email: 'nobody@example.com', password: 'anything-at-all' });
  assert.equal(google.status, 401);
  assert.deepEqual(google.body, unknown.body);
});

test('password signup cannot make a second account for a Google address by changing case', async () => {
  const res = await send('/auth/signup', {
    email: 'Google.Only@Example.com', password: 'a-password', role: 'shipper', name: 'Second Account'
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already exists/);
});

test('password signup still creates and signs in an account', async () => {
  const created = await send('/auth/signup', { email: 'pw@example.com', password: 'a-password', role: 'driver', name: 'Pat Word' });
  assert.equal(created.status, 200);
  assert.ok(created.body.user.driverId);
  const login = await send('/auth/login', { email: 'pw@example.com', password: 'a-password' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'driver');
});

test('with no client id, the config says so and the endpoint is off', async () => {
  const config = await (await fetch(`${baseUrl}/auth/google/config`)).json();
  assert.deepEqual(config, { enabled: false, client_id: null });
  assert.equal((await send('/auth/google', { credential: 'x' })).status, 404);
});

test('with a client id, the config publishes it', async () => {
  process.env.GOOGLE_CLIENT_ID = 'abc.apps.googleusercontent.com';
  try {
    const config = await (await fetch(`${baseUrl}/auth/google/config`)).json();
    assert.deepEqual(config, { enabled: true, client_id: 'abc.apps.googleusercontent.com' });
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
  }
});
