# Deploying to a Node host

`www.americashipsonclick.com` currently serves a **static** build on Vercel.
That is why `/loads` and `/dashboard` return 404 and every `/api`
route is missing: this app is an Express server, not a static site. `npm run
build` produces `dist/server.cjs`, which serves the API *and* the SPA (with a
`GET *` fallback, so deep links resolve). Something has to run that process.

`render.yaml` in the repo root is a Render Blueprint that does it.

---

## Why two database roles

`database/scripts/postgres-dev.sh` runs the app as `asoc_app`, a least-privilege
role, and reserves the owner role (`asoc`) for migrations. Production must keep
that split:

- RLS is **enabled but not forced** (`pg_class.relforcerowsecurity = false`).
- PostgreSQL exempts a table's **owner** from row-level security.
- So if `DATABASE_URL` points at the owner, every policy in
  `0002_security.sql` silently stops applying. The app still works. The
  isolation described in `SECURITY.md` is simply gone.

Neon's default role, `neondb_owner`, runs the migrations and so owns every
table. Step 1 below creates the runtime role so the app never connects as it.

---

## 1. Create the database on Neon

console.neon.tech → **New project**:

- Postgres version **16**
- Region **AWS US East 2 (Ohio)**, next to the Render service in `render.yaml`
- Database name `asoc`

The free plan suspends the compute when it is idle and wakes it on the next
connection, so the first request after a quiet spell is a little slower.

Generate a password for the runtime role:

```bash
openssl rand -hex 24
```

Then, in Neon → **SQL Editor** (database `asoc`, role `neondb_owner`):

```sql
-- Migration 0002 creates asoc_app as NOLOGIN with no password, so it cannot be
-- connected as. Creating it here first means 0002 finds it and only grants
-- privileges.
CREATE ROLE asoc_app LOGIN PASSWORD 'paste-the-generated-password';
```

Create it with SQL, **not** on Neon's Roles page. Roles made in the console
are added to `neon_superuser`, which gives them far more than the app needs.

## 2. Copy the two connection strings

Neon → **Connect** → database `asoc`, role `neondb_owner`, **Connection
pooling off**. Copy the string; it looks like:

```
postgresql://neondb_owner:<owner-password>@ep-xxxx.us-east-2.aws.neon.tech/asoc?sslmode=require
```

- `DATABASE_ADMIN_URL` is that string as is.
- `DATABASE_URL` is the same string with `neondb_owner:<owner-password>`
  replaced by `asoc_app:<the password from step 1>`.

Migrations run under `DATABASE_ADMIN_URL` at boot behind a
`pg_advisory_xact_lock`, so a rolling deploy migrates exactly once. The app
turns on TLS by itself for a remote host like Neon.

## 3. Create the Blueprint

Render → **New → Blueprint** → pick this repo, branch `main`. It reads
`render.yaml` and creates the web service on the free plan. It asks for the
values marked `sync: false`:

- `DATABASE_ADMIN_URL` and `DATABASE_URL` from step 2
- `ADMIN_PASSWORD`: 8+ characters and not the demo password published in this
  repo; the server refuses to start otherwise

`GOOGLE_CLIENT_ID` is optional and turns on Continue with Google. The README
lists the steps to create it, including the origin to authorize.

`JWT_SECRET` and `PAYMENT_TOKEN_SECRET` are generated once by Render and
persist across deploys. Rotating `JWT_SECRET` invalidates every issued token.

If you created a **Web Service** by hand instead of this Blueprint, none of
`render.yaml` applies: no generated secrets, no `NODE_ENV`, and Render guesses
the commands (it picks Bun because of `bun.lock`). The server then stops with
`JWT_SECRET must be set when NODE_ENV=production`. Delete that service and use
the Blueprint.

Do not compile in `npm start`: Render sends SIGTERM if no port is open while
Vite is still running. The Blueprint builds with `npm ci && npm run build`.

## 4. Check the deploy log

```
[DB] Connected to postgres://.../asoc (driver: postgres)
[DB] Running migrations as the owner role (DATABASE_ADMIN_URL)
[SERVER] America Ships On Click server running on http://0.0.0.0:10000
```

## 5. Verify before moving DNS

Against the `onrender.com` URL:

```bash
curl -s https://<service>.onrender.com/api/health
curl -s -o /dev/null -w '%{http_code}\n' https://<service>.onrender.com/loads  # expect 200
```

Confirm RLS is actually in force — this should return **zero rows**, because
`asoc_app` may not read another carrier's identity:

```bash
psql "<DATABASE_URL from step 2>" \
  -c "SELECT count(*) FROM driver_profiles;"
```

If it returns a count, `DATABASE_URL` is still pointing at the owner.

## 6. Move the domain

Render → service → **Settings → Custom Domains** → add
`www.americashipsonclick.com` and `americashipsonclick.com`.

Then at your DNS provider, **remove the Vercel records** and add what Render
shows:

| Type | Name | Value |
|---|---|---|
| CNAME | `www` | `<service>.onrender.com` |
| A / ALIAS | `@` | as shown by Render |

DNS currently points at Vercel (`vercel-dns-017.com`); both cannot own the
domain at once. Render issues the TLS certificate once the records resolve.

After cutover:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://www.americashipsonclick.com/loads
curl -s https://www.americashipsonclick.com/api/config
```

---

## Note on Vercel

Vercel auto-deploys this repo on every push to `main` and will keep serving the
stale static build until the domain moves. Once DNS points at Render, either
delete the Vercel project or disconnect it from the repo so the two do not
diverge.
