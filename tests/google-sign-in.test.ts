/**
 * Continue with Google, over HTTP, against the real migrations as the app's
 * database role. Only the token check is stubbed here; the real verifier has its
 * own tests below, using locally generated RSA keys. Run with: npm test
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import type { Database } from '../database';
import { ensureAdminAccount } from '../database/admin-account';
import { verifyToken } from '../backend/auth';
import { createGoogleAuthHandler, createGoogleVerifier, GoogleTokenError, type GoogleClaims } from '../backend/google-auth';
import { createMigratedDatabase, harnessDatabase, type Harness } from './helpers/migration-harness';

process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.JWT_SECRET = 'test-secret-long-enough-for-this-suite';
process.env.TRUST_PROXY = 'true';

let h: Harness;
let appDb: Database;
let ownerDb: Database;
let server: Server;
let baseUrl: string;

/** Stubbed tokens: the credential string names the claims it verifies to. */
const tokens = new Map<string, GoogleClaims>();
let tokenSeq = 0;

function googleLogin(email: string, overrides: Partial<GoogleClaims> = {}): string {
  tokenSeq += 1;
  const credential = `stub-${tokenSeq}`;
  tokens.set(credential, { sub: `sub-${tokenSeq}`, email, emailVerified: true, ...overrides });
  return credential;
}

/** Each call gets its own address unless a test is exercising the limits. */
let ipSeq = 0;
async function post(body: unknown, ip = `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`) {
  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: (await res.json()) as any };
}

const count = async (sql: string, params: unknown[] = []) =>
  (await h.pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${sql}`, params)).rows[0].n;

async function passwordAccount(email: string, role: 'driver' | 'shipper', password: string) {
  const id = `usr-${crypto.randomUUID()}`;
  const profile = `${role === 'driver' ? 'drv' : 'shp'}-${crypto.randomUUID()}`;
  await h.pg.query('INSERT INTO users (id, role, email, password_hash) VALUES ($1, $2, $3, $4)', [
    id, role, email, await bcrypt.hash(password, 4)
  ]);
  if (role === 'driver') {
    await h.pg.query(
      `INSERT INTO driver_profiles (id, user_id, full_name, home_base_city, home_base_state) VALUES ($1, $2, 'Pat', 'Dallas', 'TX')`,
      [profile, id]
    );
  } else {
    await h.pg.query(
      `INSERT INTO shipper_profiles (id, user_id, company_name, billing_email) VALUES ($1, $2, 'Pat Co', $3)`,
      [profile, id, email]
    );
  }
  return { id, profile };
}

before(async () => {
  h = await createMigratedDatabase();
  appDb = harnessDatabase(h);
  ownerDb = harnessDatabase(h, { asOwner: true });

  const app = express();
  app.use(express.json());
  app.post('/auth/google', createGoogleAuthHandler({
    db: appDb,
    verifier: async credential => {
      const claims = tokens.get(credential);
      if (!claims) throw new GoogleTokenError(401, 'Your Google sign-in could not be verified. Try again.');
      return claims;
    }
  }));
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise(resolve => server?.close(resolve));
  await h?.destroy();
});

// -- identity ---------------------------------------------------------------

test('an unverifiable credential is refused and creates nothing', async () => {
  const before = await count('users');
  const res = await post({ credential: 'forged', role: 'driver', name: 'Mallory' });
  assert.equal(res.status, 401);
  assert.equal(await count('users'), before);
});

test('a Google login with an unverified email is refused on every path', async () => {
  const email = 'unverified@example.com';
  const res = await post({ credential: googleLogin(email, { emailVerified: false }), role: 'driver', name: 'Una' });
  assert.equal(res.status, 403);
  assert.equal(await count('users WHERE email = $1', [email]), 0);

  await passwordAccount('unverified-owner@example.com', 'driver', 'correct-horse');
  const link = await post({
    credential: googleLogin('unverified-owner@example.com', { emailVerified: false }),
    password: 'correct-horse'
  });
  assert.equal(link.status, 403);
  assert.equal(await count('user_google_identities WHERE email = $1', ['unverified-owner@example.com']), 0);
});

test('identity comes from the token, not from fields in the request', async () => {
  const res = await post({
    credential: googleLogin('real@example.com'),
    email: 'someone-else@example.com',
    sub: 'someone-else',
    role: 'shipper',
    company_name: 'Real Co'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'real@example.com');
  assert.equal(await count('users WHERE email = $1', ['someone-else@example.com']), 0);
});

test('with no client id the endpoint is off', async () => {
  const saved = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    const res = await post({ credential: googleLogin('off@example.com') });
    assert.equal(res.status, 404);
  } finally {
    process.env.GOOGLE_CLIENT_ID = saved;
  }
});

// -- new accounts -----------------------------------------------------------

test('a new Google user is asked to choose, and nothing is created until they do', async () => {
  const res = await post({ credential: googleLogin('newcomer@example.com', { name: 'New Comer' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'needs_registration', email: 'newcomer@example.com', name: 'New Comer' });
  assert.equal(await count('users WHERE email = $1', ['newcomer@example.com']), 0);
});

test('a Google driver gets the same rows as a password driver, still pending, with no password', async () => {
  const res = await post({
    credential: googleLogin('Driver.One@Example.com'.toLowerCase()),
    role: 'driver',
    name: 'Driver One',
    phone: '18005550199',
    home_city: 'Joplin',
    home_state: 'MO'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'created');

  const session = verifyToken(res.body.token)!;
  assert.equal(session.role, 'driver');
  assert.equal(session.id, res.body.user.id);
  assert.ok(session.driverId);

  const user = (await h.pg.query<any>('SELECT * FROM users WHERE id = $1', [session.id])).rows[0];
  assert.equal(user.password_hash, null);
  assert.equal(user.phone, '18005550199');

  const profile = (await h.pg.query<any>('SELECT * FROM driver_profiles WHERE id = $1', [session.driverId])).rows[0];
  assert.equal(profile.verification_status, 'pending');
  assert.equal(profile.full_name, 'Driver One');
  assert.equal(profile.home_base_city, 'Joplin');
  assert.equal(await count('driver_equipment WHERE driver_id = $1', [session.driverId]), 1);
  assert.equal(await count('driver_payment_accounts WHERE driver_id = $1', [session.driverId]), 1);
});

test('a Google shipper gets a shipper profile', async () => {
  const res = await post({ credential: googleLogin('ship@example.com'), role: 'shipper', company_name: 'Ship Co' });
  assert.equal(res.body.status, 'created');
  const session = verifyToken(res.body.token)!;
  assert.equal(session.role, 'shipper');
  const profile = (await h.pg.query<any>('SELECT * FROM shipper_profiles WHERE id = $1', [session.shipperId])).rows[0];
  assert.equal(profile.company_name, 'Ship Co');
  assert.equal(profile.billing_email, 'ship@example.com');
});

test('registration still needs a name', async () => {
  const res = await post({ credential: googleLogin('noname@example.com'), role: 'driver' });
  assert.equal(res.status, 400);
  assert.equal(await count('users WHERE email = $1', ['noname@example.com']), 0);
});

test('admin cannot be chosen as a role', async () => {
  const res = await post({ credential: googleLogin('wants-admin@example.com'), role: 'admin', name: 'Wants Admin' });
  assert.equal(res.status, 400);
  assert.equal(await count('users WHERE email = $1', ['wants-admin@example.com']), 0);
});

test('Google signups share the password signup limit for a network', async () => {
  const ip = '172.16.0.1';
  for (let i = 0; i < 5; i += 1) {
    const res = await post({ credential: googleLogin(`limit${i}@example.com`), role: 'shipper', name: 'Limit Co' }, ip);
    assert.equal(res.body.status, 'created');
  }
  const res = await post({ credential: googleLogin('limit5@example.com'), role: 'shipper', name: 'Limit Co' }, ip);
  assert.equal(res.status, 429);
  assert.equal(await count('users WHERE email = $1', ['limit5@example.com']), 0);
});

// -- returning users --------------------------------------------------------

test('a returning Google user keeps their role, whatever the request asks for', async () => {
  const credential = googleLogin('returning@example.com');
  const first = await post({ credential, role: 'driver', name: 'Back Again' });
  assert.equal(first.body.status, 'created');
  const firstSession = verifyToken(first.body.token)!;

  const again = await post({ credential, role: 'shipper', company_name: 'Sneaky Co' });
  assert.equal(again.body.status, 'signed_in');
  const session = verifyToken(again.body.token)!;
  assert.equal(session.id, firstSession.id);
  assert.equal(session.role, 'driver');
  assert.equal(session.driverId, firstSession.driverId);
  assert.equal(await count('shipper_profiles WHERE user_id = $1', [session.id]), 0);
});

test('signing in again does not change driver verification', async () => {
  const credential = googleLogin('still-pending@example.com');
  const first = await post({ credential, role: 'driver', name: 'Still Pending' });
  await post({ credential });
  const profile = (await h.pg.query<any>('SELECT verification_status FROM driver_profiles WHERE user_id = $1', [first.body.user.id])).rows[0];
  assert.equal(profile.verification_status, 'pending');
});

test('a linked login still works after the Google address changes', async () => {
  const sub = 'sub-moves-address';
  const first = await post({ credential: googleLogin('old-address@example.com', { sub }), role: 'driver', name: 'Moved Person' });
  const res = await post({ credential: googleLogin('new-address@example.com', { sub }) });
  assert.equal(res.body.status, 'signed_in');
  assert.equal(res.body.user.id, first.body.user.id);
  assert.equal(res.body.user.email, 'old-address@example.com');
});

// -- matching a password account --------------------------------------------

test('a matching password account needs its password before it is linked', async () => {
  const { id, profile } = await passwordAccount('owner@example.com', 'shipper', 'correct-horse');
  const credential = googleLogin('owner@example.com');

  const asked = await post({ credential });
  assert.deepEqual(asked.body, { status: 'link_required', email: 'owner@example.com' });

  // Choosing a role is not a way around it.
  const pushed = await post({ credential, role: 'driver', name: 'Pushy' });
  assert.equal(pushed.body.status, 'link_required');

  const wrong = await post({ credential, password: 'not-the-password' });
  assert.equal(wrong.status, 401);
  assert.equal(await count('user_google_identities WHERE user_id = $1', [id]), 0);

  const linked = await post({ credential, password: 'correct-horse' });
  assert.equal(linked.body.status, 'signed_in');
  const session = verifyToken(linked.body.token)!;
  assert.equal(session.id, id);
  assert.equal(session.role, 'shipper');
  assert.equal(session.shipperId, profile);

  // No password from here on, and the password itself is untouched.
  const again = await post({ credential: googleLogin('owner@example.com', { sub: tokens.get(credential)!.sub }) });
  assert.equal(again.body.status, 'signed_in');
  const user = (await h.pg.query<any>('SELECT role, password_hash FROM users WHERE id = $1', [id])).rows[0];
  assert.equal(user.role, 'shipper');
  assert.ok(await bcrypt.compare('correct-horse', user.password_hash));
});

test('the address match ignores case', async () => {
  await passwordAccount('Mixed.Case@Example.com', 'driver', 'correct-horse');
  const res = await post({ credential: googleLogin('mixed.case@example.com') });
  assert.equal(res.body.status, 'link_required');
});

test('wrong link passwords hit the sign-in lockout', async () => {
  await passwordAccount('locked@example.com', 'driver', 'correct-horse');
  const credential = googleLogin('locked@example.com');
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await post({ credential, password: 'guess' })).status, 401);
  }
  const res = await post({ credential, password: 'correct-horse' });
  assert.equal(res.status, 429);
});

test('a second Google login cannot take over a linked account', async () => {
  const first = await post({ credential: googleLogin('taken@example.com'), role: 'driver', name: 'First Person' });
  assert.equal(first.body.status, 'created');
  const res = await post({ credential: googleLogin('taken@example.com'), password: 'anything' });
  assert.equal(res.status, 409);
  assert.equal(res.body.token, undefined);
});

// -- administrators ---------------------------------------------------------

async function adminAccount(email: string, password: string) {
  const id = `usr-${crypto.randomUUID()}`;
  await h.pg.query(`INSERT INTO users (id, role, email, password_hash) VALUES ($1, 'admin', $2, $3)`, [
    id, email, await bcrypt.hash(password, 4)
  ]);
  return id;
}

test('an administrator cannot sign in or link through Google', async () => {
  const id = await adminAccount('boss@example.com', 'correct-horse');
  const credential = googleLogin('boss@example.com');
  for (const body of [{ credential }, { credential, password: 'correct-horse' }, { credential, role: 'driver', name: 'Boss' }]) {
    const res = await post(body);
    assert.equal(res.status, 403);
    assert.equal(res.body.token, undefined);
  }
  assert.equal(await count('user_google_identities WHERE user_id = $1', [id]), 0);
});

test('a differently-cased driver row cannot step around an administrator', async () => {
  await adminAccount('Chief@example.com', 'correct-horse');
  await passwordAccount('chief@example.com', 'driver', 'correct-horse');
  const res = await post({ credential: googleLogin('chief@example.com'), password: 'correct-horse' });
  assert.equal(res.status, 403);
});

test('promoting a Google-only account provisions a password and ends its Google sign-in', async () => {
  const credential = googleLogin('future-admin@example.com');
  const created = await post({ credential, role: 'driver', name: 'Future Admin' });
  assert.equal(created.body.status, 'created');

  process.env.ADMIN_EMAIL = 'future-admin@example.com';
  process.env.ADMIN_PASSWORD = 'a-long-admin-password';
  try {
    const outcome = await ensureAdminAccount(ownerDb);
    assert.equal(outcome.status, 'rotated');
  } finally {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  }

  const res = await post({ credential });
  assert.equal(res.status, 403);
});

// -- database rules ---------------------------------------------------------

const insertLink = 'INSERT INTO user_google_identities (id, google_sub, user_id, email) VALUES ($1, $2, $3, $4)';

test('RLS: enrollment cannot link a password account', async () => {
  const { id } = await passwordAccount('rls-enroll@example.com', 'driver', 'correct-horse');
  await assert.rejects(
    appDb.as({ role: 'enrollment' }).query(insertLink, ['gid-e', 'sub-e', id, 'rls-enroll@example.com']),
    /row-level security/
  );
});

test('RLS: one user cannot link a Google login to another user', async () => {
  const { id } = await passwordAccount('rls-victim@example.com', 'driver', 'correct-horse');
  const { id: other } = await passwordAccount('rls-attacker@example.com', 'driver', 'correct-horse');
  await assert.rejects(
    appDb.as({ role: 'driver', userId: other }).query(insertLink, ['gid-o', 'sub-o', id, 'rls-victim@example.com']),
    /row-level security/
  );
});

test('RLS: nobody can link a Google login to an administrator, even an administrator', async () => {
  const id = await adminAccount('rls-admin@example.com', 'correct-horse');
  await assert.rejects(
    appDb.as({ role: 'admin', userId: id }).query(insertLink, ['gid-a', 'sub-a', id, 'rls-admin@example.com']),
    /row-level security/
  );
});

test('the app role cannot rewrite or remove a link, or update a user', async () => {
  const session = { role: 'admin', userId: 'usr-any' } as const;
  await assert.rejects(appDb.as(session).query(`UPDATE user_google_identities SET user_id = 'x'`), /permission denied/);
  await assert.rejects(appDb.as(session).query('DELETE FROM user_google_identities'), /permission denied/);
  await assert.rejects(appDb.as(session).query(`UPDATE users SET role = 'admin'`), /permission denied/);
});

test('RLS: a logged-in user sees only their own link', async () => {
  const first = await post({ credential: googleLogin('rls-own@example.com'), role: 'driver', name: 'Own Link' });
  const rows = await appDb.as({ role: 'driver', userId: first.body.user.id }).query('SELECT user_id FROM user_google_identities');
  assert.deepEqual(rows.rows.map(r => r.user_id), [first.body.user.id]);
  const anon = await appDb.as({ role: 'anon' }).query('SELECT 1 FROM user_google_identities');
  assert.equal(anon.rows.length, 0);
});

test('an administrator row must have a password; other rows must have bcrypt or nothing', async () => {
  await assert.rejects(
    h.pg.query(`INSERT INTO users (id, role, email, password_hash) VALUES ('usr-nopass', 'admin', 'nopass@example.com', NULL)`),
    /users_admin_has_password/
  );
  await assert.rejects(
    h.pg.query(`INSERT INTO users (id, role, email, password_hash) VALUES ('usr-plain', 'driver', 'plain@example.com', 'hunter2')`),
    /users_password_is_bcrypt/
  );
});

// -- the real verifier, with local keys --------------------------------------

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const other = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

/** The real OAuth2Client; only the download of Google's keys is replaced. */
function localVerifier() {
  const client = new OAuth2Client(CLIENT_ID);
  (client as any).getFederatedSignonCertsAsync = async () => ({ certs: { 'key-1': publicKey }, format: 'PEM' });
  return createGoogleVerifier(CLIENT_ID, client);
}

function idToken(claims: Record<string, unknown> = {}, key: string = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: '1234567890',
      email: 'Person@Example.com',
      email_verified: true,
      name: 'A Person',
      iat: now - 10,
      exp: now + 600,
      ...claims
    },
    key,
    { algorithm: 'RS256', keyid: 'key-1' }
  );
}

const rejected = { name: 'GoogleTokenError', status: 401 };

test('verifier: a valid token yields its claims, with the address lower-cased', async () => {
  const claims = await localVerifier()(idToken());
  assert.deepEqual(claims, { sub: '1234567890', email: 'person@example.com', emailVerified: true, name: 'A Person' });
});

test('verifier: email_verified is reported as given', async () => {
  assert.equal((await localVerifier()(idToken({ email_verified: false }))).emailVerified, false);
  const now = Math.floor(Date.now() / 1000);
  const missing = jwt.sign(
    { iss: 'accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'a@example.com', iat: now, exp: now + 60 },
    privateKey,
    { algorithm: 'RS256', keyid: 'key-1' }
  );
  assert.equal((await localVerifier()(missing)).emailVerified, false);
});

test('verifier: rejects another app\'s token', async () => {
  await assert.rejects(localVerifier()(idToken({ aud: 'someone-else.apps.googleusercontent.com' })), rejected);
});

test('verifier: rejects an expired token', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(localVerifier()(idToken({ iat: now - 7200, exp: now - 3600 })), rejected);
});

test('verifier: rejects another issuer', async () => {
  await assert.rejects(localVerifier()(idToken({ iss: 'https://accounts.evil.example' })), rejected);
});

test('verifier: rejects a token signed with the wrong key', async () => {
  await assert.rejects(localVerifier()(idToken({}, other.privateKey)), rejected);
});

test('verifier: rejects an unsigned token', async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'none', kid: 'key-1' })}.${b64({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'a@example.com',
    email_verified: true, iat: now, exp: now + 60
  })}.`;
  await assert.rejects(localVerifier()(unsigned), rejected);
});

test('verifier: rejects a token with no email', async () => {
  await assert.rejects(localVerifier()(idToken({ email: undefined })), rejected);
});

test('verifier: rejects garbage', async () => {
  await assert.rejects(localVerifier()('not-a-token'), rejected);
});

test('verifier: failing to reach Google is not reported as a bad token', async () => {
  const client = new OAuth2Client(CLIENT_ID);
  (client as any).getFederatedSignonCertsAsync = async () => {
    const err = new Error('network down');
    err.name = 'GaxiosError';
    throw err;
  };
  await assert.rejects(createGoogleVerifier(CLIENT_ID, client)(idToken()), { name: 'GoogleTokenError', status: 503 });
});
