# America Ships On Click — Full-Stack Freight Load Board & Open Books Ledger

"America Ships On Click" is a direct no-broker freight load board with a public "Open Books" settlement ledger. Shippers post loads, motor carriers book and haul them direct, and every completed transaction publishes transparent financial reporting to the public ledger.

---

## 🚀 Architectural Highlights

- **Single Source of Truth for Platform Fees**: Platform fee (7%), quick pay / same-day funding cost (3%), and fuel rates live in the `platform_config` database table and are exposed via `GET /api/config`. The frontend dynamically fetches and applies these rates across the live calculator, load board take-home math, and booking confirmations.
- **Server-Authoritative Settlement Math**: All fee, gross, fuel, factor, and carrier net calculations are executed server-side upon booking completion. The frontend never computes numbers independently from backend agreement.
- **Real DB Aggregate View**: Headline stats (Loads Settled, Miles Hauled, Total Paid to Carriers) are computed directly via `settlement_totals_view` SQL query rather than incremented counters to ensure totals never drift from the underlying settlement rows.
- **Transactional Double-Booking Protection**: Booking an open load runs on a single pooled connection inside one transaction, using explicit row locking (`FOR UPDATE`) and partial unique index constraints (`WHERE status NOT IN ('cancelled')`) to guarantee atomic single-driver bookings.
- **Database-Enforced Security**: The server connects as a least-privilege role that cannot run DDL, delete rows, or read the audit log. Row-Level Security decides which rows each request may touch from the caller's verified identity, CHECK constraints make an unbalanced settlement or a plaintext password unwritable, settlements and audit rows are append-only, and every sensitive write is recorded by a trigger the application cannot bypass. See [Security model](#-security-model).
- **Pluggable PostgreSQL Backend**: One `Database` contract, two drivers — a pooled `pg` client against a real PostgreSQL server (`DATABASE_URL`), or embedded PGlite for zero-setup local development. Versioned SQL migrations are tracked in `schema_migrations` and applied under an advisory lock on boot.
- **Real-Time Live Ledger Push**: Connected via Server-Sent Events (SSE) at `/api/realtime/stream` pushing instant updates to Open Books and homepage ticker.
- **Tokenized Driver Payments**: Bank routing and account details are tokenized prior to persistence; raw banking details are never stored.

---

## 🛠 Tech Stack

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS + TanStack Query + SSE Client
- **Backend**: Express + Node.js + TypeScript
- **Database**: PostgreSQL over a `pg` connection pool, with an embedded PGlite fallback for zero-setup local dev — raw SQL migrations, enums, views, and indexes
- **Auth**: JWT Authentication with Driver, Shipper, and Admin RBAC

---

## 📁 Project Structure

The three layers live in three separate top-level directories. Dependencies only
ever point one way — `frontend/` talks to the backend over HTTP and never
imports from it, `backend/` imports the database layer, and `database/` imports
neither of the others.

```
frontend/                 Browser bundle (Vite root)
  index.html              HTML entry
  src/
    main.tsx              React root
    App.tsx               Router / shell
    index.css             Tailwind entry
    components/           Navbar, Footer, AuthModal
    pages/                Home, FindLoads, OpenBooks, PostLoad, DriveWithUs, Dashboard
    lib/                  api.ts (HTTP client), useRealtimeSettlements.ts (SSE)
    types/                Shared API response types

backend/                  Express API (Node)
  server.ts               Entry: middleware, static/Vite serving, lifecycle
  routes.ts               All /api routes
  auth.ts                 JWT issue/verify, RBAC guards
  security.ts             Tokenization, session context, request helpers

database/                 Data layer (Node)
  index.ts                Public surface: initDb, db, pingDb, closeDb
  client.ts               Database contract + pg and PGlite drivers
  schema.ts               Row types and enums
  migrate.ts              Versioned migration runner
  seed.ts                 Demo data
  cli.ts                  npm run db:* commands
  migrations/             Numbered .sql migrations (source of truth)
  sql/                    Portable pg_dump exports
  scripts/                postgres-dev.sh, export-sql.sh
```

Cross-layer imports are limited to `backend/ -> database/`:

| From | Imports |
| --- | --- |
| `backend/server.ts` | `../database` |
| `backend/routes.ts` | `../database` |
| `backend/auth.ts` | `../database/schema` |
| `backend/security.ts` | `../database` (types only) |

---

## 🗄 Database Backend

The server talks to PostgreSQL through a pooled `pg` client. Two interchangeable
backends implement the same contract (`database/client.ts`), so identical SQL,
migrations, transactions, and `FOR UPDATE` locking run against both:

| Backend | When it is used | Storage |
| --- | --- | --- |
| `postgres` | `DATABASE_URL` is set (**required in production**) | Your PostgreSQL server, via a `pg` pool |
| `pglite` | `DATABASE_URL` is unset (development only) | Embedded WASM Postgres at `.data/pgdata` |

### Quick start (project-local database)

`npm run db:up` provisions and starts a real PostgreSQL server owned by your user
account under `.data/cluster` — no Docker, no `sudo`, and no conflict with a
system-wide Postgres (it listens on `127.0.0.1:5433`). It prints a
`DATABASE_URL`; put that in `.env`.

```bash
npm run db:up        # create + start the database, prints DATABASE_URL
npm run db:migrate   # apply the schema
npm run dev          # http://localhost:3000
```

`npm run dev` connects, migrates, and seeds on boot, so `db:migrate` is optional
locally — the explicit commands exist for CI and deploy pipelines.

| Command | What it does |
| --- | --- |
| `npm run db:up` | Start the local cluster (creating it on first run) |
| `npm run db:down` | Stop it, keeping the data |
| `npm run db:psql` | Open a `psql` shell on it |
| `npm run db:destroy -- --force` | **Destructive.** Stop it and delete `.data/cluster` |

The cluster is loopback-only with a generated password stored in
`.data/cluster.password` (both gitignored). It does not start at boot — run
`npm run db:up` after a reboot. Prefer Docker? `docker compose up -d` starts an
equivalent Postgres on `:5432`; use its URL instead.

### Other PostgreSQL servers

Any connection string works — the app only needs `DATABASE_URL`:

```bash
cp .env.example .env      # then edit DATABASE_URL
npm run db:migrate
npm run dev
```

Hosted providers work the same way:

```env
DATABASE_URL="postgresql://user:password@db.example.supabase.co:5432/postgres"
```

TLS is auto-detected (enabled for remote hosts, off for localhost) and can be
forced with `DATABASE_SSL=disable | require | verify-full`.

### Portable SQL exports (`database/sql/`)

The whole database is also checked in as plain `.sql`, for loading into a
console, handing to a DBA, or bootstrapping a hosted database without running
the app:

| File | Contents |
| --- | --- |
| `database/sql/schema.sql` | Structure only — enums, tables, views, indexes, constraints (regenerate after migrations) |
| `database/sql/data.sql` | Rows only, as portable `INSERT` statements (load `schema.sql` first) |
| `database/sql/security.sql` | Runtime role, GRANTs and REVOKEs (RLS policies travel inside `schema.sql`) |
| `database/sql/database.sql` | Schema + data in one file — rebuilds everything from scratch |

```bash
psql "$DATABASE_URL" -f database/sql/database.sql
```

They contain no psql-only meta-commands, so they also paste straight into the
Supabase SQL editor, pgAdmin's query tool, or any driver-based import. Data is
dumped with `--column-inserts` rather than `COPY`, so it loads regardless of
column ordering.

Regenerate them from a live database after a schema change:

```bash
npm run db:export
```

The dump includes the `schema_migrations` row, so an imported database is
recognized as already migrated and the app will not try to re-apply `0001`.
Migrations in `database/migrations/` remain the source of truth — these files are
generated output.

## 🔒 Security model

Application code decides what a request *means*; the database decides what it is
*allowed to touch*. Both have to agree, so a bug in a route cannot become a data
breach on its own.

### Two roles

| Role | Used by | Can |
| --- | --- | --- |
| `asoc` (owner) | `npm run db:migrate`, seeding, backups | Everything: DDL, policy changes |
| `asoc_app` | The running server (`DATABASE_URL`) | `SELECT`/`INSERT`/`UPDATE` on the tables it needs — no DDL, no `DELETE`, no `TRUNCATE`, no access to `audit_log` |

Migrations connect through `DATABASE_ADMIN_URL` and that connection is closed as
soon as startup finishes; the long-lived pool only ever holds `asoc_app`.

### Row-Level Security

Every request runs inside a transaction that first states who is asking:

```sql
SELECT set_config('app.user_role', 'driver', true),
       set_config('app.driver_id', 'drv-001', true), ...
```

Policies read those settings, so scope is enforced by PostgreSQL for every
statement. The settings are transaction-scoped (`true`), so identity can never
leak between pooled requests. They are derived from the verified JWT only —
never from a header or request body.

| Table | Who can read | Who can write |
| --- | --- | --- |
| `loads`, `settlements`, `platform_config` | Everyone at the row level (the ledger is public); the API serves the load board to drivers and admins only | Owning shipper / booked driver / admin |
| `bookings` | The booked driver, the load's shipper, admins | The booked driver, admins |
| `driver_payment_accounts`, `driver_documents`, `driver_equipment` | The owning driver, admins | The owning driver, enrollment, admins |
| `users`, `driver_profiles`, `shipper_profiles` | Self, admins, and the pre-auth `auth`/`enrollment` contexts | Enrollment, admins |
| `audit_log` | Admins (and the owner role) | Nobody — only the trigger |

Pre-authentication flows get their own narrow contexts: `auth` (credential
check) and `enrollment` (signup and onboarding), which can create an account but
cannot read another driver's payment details.

The load board joins `public_shipper_view`, a two-column projection of
`shipper_profiles`, because RLS is row-scoped and the base table also holds
billing contacts.

### Constraints that make bad data unwritable

- `users.password_hash` must be a bcrypt digest — a plaintext password cannot be stored, whatever the application does.
- `driver_payment_accounts.processor_account_id` rejects anything shaped like a bare account number.
- `settlements` must balance: `net = gross - fee - fuel - factor` and `gross = miles x rate`, to the cent. A fabricated payout row is rejected even when written by the owner.
- Money and distance columns reject negative values; `fee_pct_applied` is capped at 50%.

### Append-only ledger and audit trail

`settlements` and `audit_log` carry triggers that refuse `UPDATE` and `DELETE`
for everyone, including the owner. A trigger records every write to `users`,
`loads`, `bookings`, `settlements`, `driver_payment_accounts`, and
`platform_config` with the acting identity, redacting `password_hash` and
`processor_account_id`. It runs as `SECURITY DEFINER`, so the application role
can neither forge entries nor read them back.

### Credentials and sessions

- Bank details are tokenized with **HMAC-SHA256** (`PAYMENT_TOKEN_SECRET`), which is irreversible — the previous base64 "tokenization" was decodable by anyone holding the value.
- `JWT_SECRET` has no production fallback: the server refuses to start without one of at least 32 characters. Tokens are signed and verified with a pinned `HS256`, blocking algorithm-confusion and `alg: none` forgeries.
- Failed sign-ins are recorded in the database and lock an account after 5 failures in 15 minutes, so throttling survives restarts and applies across every instance. Unknown accounts are compared against a dummy hash so response timing does not reveal which emails exist.
- Identifiers (`LD-`, `BK-`, `STL-`, `usr-`) come from `crypto.randomBytes`, not timestamps, so one id never reveals the next.

### Uploads

Documents are stored under a generated name with an extension derived from an
allowlist (PNG/JPEG/WebP/PDF, 10 MB cap), and served with
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and a
`sandbox` CSP — so an uploaded file cannot execute in the app's origin.

### What this does not cover

No CSP on the application HTML itself (Vite's dev server needs inline scripts),
no CSRF tokens (the API is JWT-in-header, not cookie-based, so it is not
cross-site forgeable today), and no rate limiting on endpoints other than login.
The embedded PGlite fallback connects as a superuser, which bypasses RLS by
design — develop against a real PostgreSQL server when you are testing policies.

[`docs/SECURITY.md`](docs/SECURITY.md) goes through every policy in detail, explains
the request contexts and the two bugs migrations 0004 and 0005 record, and carries
the full list of known gaps — including one that matters more than anything above:
**`POST /api/auth/signup` accepts `role: "admin"`**, so an admin account is currently
one unauthenticated request away.

---

### Schema & data commands

| Command | What it does |
| --- | --- |
| `npm run db:status` | Shows the connection target and which migrations are applied |
| `npm run db:migrate` | Applies pending migrations |
| `npm run db:seed` | Seeds demo data (only into an empty database, unless `--force`) |
| `npm run db:reset -- --force` | **Destructive.** Drops everything, re-migrates, re-seeds |
| `npm run db:ping` | Verifies the database is reachable |
| `npm run db:export` | Regenerates the `database/sql/` exports from the live database |

### Migrations

Every `database/migrations/*.sql` file is applied once, in filename order, and
recorded in the `schema_migrations` table with a checksum. All pending files run
inside a single transaction — Postgres DDL is transactional, so a failure leaves
the schema untouched instead of half-migrated. Concurrent instances serialize on
a `pg_advisory_xact_lock`, so a rolling deploy migrates exactly once.

To change the schema, add a new numbered file (`0002_...sql`); editing an applied
migration is detected by checksum and warned about, not silently re-run. The
build copies migrations to `dist/migrations` for production; `MIGRATIONS_DIR`
overrides the location.

### Transactions & connection pooling

Multi-statement writes go through `db.transaction(...)`, which runs the whole
block on one dedicated pooled connection. This matters for booking a load:
`SELECT ... FOR UPDATE` only holds its lock for statements issued on the same
client, so a `BEGIN` issued on a shared handle would not be atomic against a
pool. Booking, settlement, signup, and driver onboarding are each a single
transaction, and the SSE broadcast fires only after `COMMIT`.

Pool size and timeouts are tunable via `DATABASE_POOL_MAX`,
`DATABASE_IDLE_TIMEOUT_MS`, and `DATABASE_CONNECT_TIMEOUT_MS`. Connections are
drained on `SIGTERM`/`SIGINT`.

### Seeding

An empty database is seeded with demo accounts, open loads, and historical
settlements. Seeding is on in development and off in production; set
`DB_SEED=true` to force it or `DB_SEED=false` to disable it. Demo accounts use
the password `password123` (`DEMO_PASSWORD` overrides) — do not seed a
production database that real users can reach.

---

## ⚙️ Environment Variables & Config

Define environment variables in `.env` (see `.env.example` for the full list):

```env
# PostgreSQL connection string. Required when NODE_ENV=production.
# Omit in development to fall back to the embedded PGlite engine.
DATABASE_URL="postgresql://asoc:asoc@localhost:5432/asoc"

# TLS: disable | require | verify-full. Omit to auto-detect.
# DATABASE_SSL="require"

# Demo data seeding: true | false (defaults to on outside production)
# DB_SEED="false"

# API Base URL for frontend client (defaults to /api if unassigned)
VITE_API_BASE_URL="/api"

# Secret key for signing JWT tokens
JWT_SECRET="americashipsonclick_secret_jwt_key_2026"
```

---

## 📡 API Endpoints

### 1. Public & Config
- `GET /api/config` — Fetches authoritative platform fee rates and settings
- `GET /api/health` — Server health check, including a live database round-trip (503 when the database is unreachable)

### 2. Authentication
- `POST /api/auth/signup` — Driver, Shipper, or Admin account creation
- `POST /api/auth/login` — Account login, returns JWT token
- `GET /api/auth/me` — Authenticated user details & profile

### 3. Freight Loads
- `GET /api/loads` — Search & filter open loads (origin, destination, equipment, min rate). Drivers and admins only
- `GET /api/loads/:id` — Load details. Drivers, admins, or the shipper who posted it
- `GET /api/shipper/loads` — The signed-in shipper's own loads, every status
- `POST /api/loads` — Shipper posts a new load

### 4. Bookings & Settlements
- `POST /api/bookings` — Driver books open load (transactionally locked)
- `PATCH /api/bookings/:id/pod` — Upload Proof of Delivery (POD)
- `PATCH /api/bookings/:id/complete` — Complete booking & trigger authoritative settlement calculation
- `GET /api/settlements` — Public Open Books ledger (paginated)
- `GET /api/settlements/aggregate` — DB aggregate totals query

### 5. Driver Onboarding & Uploads
- `POST /api/drivers/onboard` — 4-step onboarding wizard submission
- `POST /api/uploads/file` — Document file upload handler
- `GET /api/uploads/signed-url` — Signed URL metadata generator

### 6. Admin & Real-Time Stream
- `GET /api/admin/ledger` — Admin-gated detailed ledger view
- `GET /api/admin/export` — Download CSV export of all settlements
- `GET /api/realtime/stream` — SSE real-time settlement push channel

---

## 🗄 Database Schema & Migration Files

- Migration files: `/database/migrations/*.sql` (applied and tracked by `database/migrate.ts`)
- Portable exports: `/database/sql/schema.sql`, `/database/sql/data.sql`, `/database/sql/database.sql` (regenerate with `npm run db:export`)
- Client & pooling: `/database/client.ts`; seeding: `/database/seed.ts`; CLI: `/database/cli.ts`
- ERD Diagram: `/docs/ERD.mermaid` and `/docs/ERD.md`
- Settlement math & booking lifecycle: [`/docs/SETTLEMENT.md`](docs/SETTLEMENT.md) — where every ledger number is decided, and why
- Identity, roles, and RLS: [`/docs/SECURITY.md`](docs/SECURITY.md) — request contexts, every policy, and the two bugs migrations 0004 and 0005 record
- Carrier onboarding: [`/docs/ONBOARDING.md`](docs/ONBOARDING.md) — the four-step wizard, what each step persists, and what it only appears to verify

### Main Tables:
- Identity: `users`, `driver_profiles`, `driver_documents`, `driver_equipment`, `driver_payment_accounts`, `shipper_profiles`, `verification_reviews`
- Freight: `loads`, `bookings`, `load_events`, `load_offers`, `settlements`, `settlement_disputes`, `settlement_adjustments`, `platform_config`
- Phase 1 token: `wallets`, `chain_contracts`, `webhook_receipts`, `contract_events`, `token_buys`, `token_positions`, `app_memberships`, `premium_attestations`, `hourly_epochs`, `transaction_reserves`, `hourly_claims`, `driver_payouts`
- Phase 2 (empty): `haul_receipts`
- Ops: `ratings`, `notifications`, `audit_log`, `refresh_tokens`, `schema_migrations`

### Database Views:
- `public_ledger_view`: Joins settlements to loads while preserving driver/shipper anonymity.
- `settlement_totals_view`: Aggregate query computing total count, miles, gross, fee, fuel cost, factor cost, and carrier net.

---

## 🧪 Testing the App

1. **Preset Demo Logins**: Click "Sign In / Switch Role" in the top bar to instantly log in as a Driver (`john.smith@trucking.com`), Shipper (`logistics@apexlogistics.com`), or Admin (`admin@americashipsonclick.com`).
2. **Find Loads**: Search and view loads. Notice carrier take-home pay is computed using fee % fetched from `/api/config`.
3. **Open Books**: Watch live settlements stream in via SSE. Note the donut chart and rate/mile bar chart.
4. **Drive With Us**: Complete the 4-step wizard with file uploads. Progress persists across page refresh.
5. **Post a Load**: Test the live fee calculator as you enter miles and rate.
6. **Dashboard**: View the auth-gated owner dashboard and download CSV exports.
