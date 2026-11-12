# Identity, and what the database will let it touch

Two systems have to agree before a row moves. Application code decides what a
request *means* — this is a driver, they are booking load `LD-x`. PostgreSQL
decides what that identity is *allowed to reach*, from policies the query cannot
argue with. Neither is trusted alone, so a route that forgets a check does not
become a data breach on its own, and a policy that is too broad still meets a
route that refuses.

This document covers the identity half. The money half — settlement arithmetic,
append-only ledger, double-booking — is in [SETTLEMENT.md](SETTLEMENT.md).

## Two roles, and why the app cannot update a user

The migrations run as `asoc`, the schema owner. The server never connects as
that role. It connects as `asoc_app`, which was created `NOLOGIN` with no
password ([`0002_security.sql:31`](../database/migrations/0002_security.sql)) —
provisioning grants it login and sets a secret, so the migration itself never
holds a credential. `DATABASE_ADMIN_URL` carries the owner connection for
migrations and is closed as soon as boot finishes; the long-lived pool only ever
holds `asoc_app`.

`REVOKE ALL ON SCHEMA public FROM PUBLIC` comes first, so every privilege after
it is deliberate. The grants are worth reading as a list of decisions rather
than a list of permissions:

| Table | Granted | The decision |
| --- | --- | --- |
| `users` | `SELECT, INSERT` | No route changes a user row, so no route may. The application cannot rewrite a `password_hash` or promote a `role` even with arbitrary SQL execution. |
| `driver_profiles`, `driver_equipment`, `driver_payment_accounts` | `SELECT, INSERT, UPDATE` | Onboarding edits these. |
| `driver_documents`, `shipper_profiles` | `SELECT, INSERT` | Written once. |
| `loads`, `bookings` | `SELECT, INSERT, UPDATE` | Status advances over a load's life. |
| `settlements` | `SELECT, INSERT` | The ledger is append-only. |
| `platform_config`, `schema_migrations` | `SELECT` | Changing a fee is an operator action performed as the owner. |
| `audit_log` | *nothing* | The application cannot read its own audit trail, let alone edit it. |

`DELETE` and `TRUNCATE` appear nowhere. There is no application code path that
destroys a row, so the role that runs application code cannot.

At the end of the same migration the role also gets `statement_timeout = 15s`,
`idle_in_transaction_session_timeout = 30s`, and `lock_timeout = 5s`
([`0002_security.sql:481`](../database/migrations/0002_security.sql)), so a
runaway or hostile query cannot pin a pooled connection indefinitely. The block
degrades to a `NOTICE` on managed servers that forbid `ALTER ROLE`.

## Seven contexts, set per transaction

Identity reaches the database as four `app.*` session settings, written by one
parameterized statement ([`client.ts:46`](../database/client.ts)):

```sql
SELECT set_config('app.user_role', $1, true),
       set_config('app.user_id',   $2, true),
       set_config('app.driver_id', $3, true),
       set_config('app.shipper_id',$4, true)
```

The third argument is the whole point. `true` means *local to this transaction*
— the settings vanish at `COMMIT` or `ROLLBACK`. On a connection pool that is
not a nicety: without it, one request's identity would persist on the connection
and be inherited by whoever borrowed it next, which is a cross-tenant data leak
with no code path to blame. It also means a scoped query must be a transaction,
which is why `db.as(ctx)` wraps every single statement in one
([`client.ts:93`](../database/client.ts)).

Seven roles exist, and four of them are not users:

| Context | When | Exists because |
| --- | --- | --- |
| `anon` | Public reads — the ledger, `/api/config` | Unauthenticated visitors are a first-class caller here, not an error |
| `auth` | Inside `POST /auth/login` only | Checking a password requires reading a `users` row *before* any identity exists |
| `enrollment` | Inside `POST /auth/signup` only | Creating an account requires inserting rows before an identity exists |
| `webhook` | Chain-indexer ingest after the route verifies the vendor signature | Phase 1 mint / stake / bonus events must be writable without a user JWT |
| `driver` / `shipper` / `admin` | Authenticated requests | The verified JWT |

`auth` and `enrollment` are the interesting ones. A naive design gives signup
and login superuser reach because they run "before security"; here they are
narrow contexts with their own policies. `auth` may `SELECT` from `users` and
the profile tables and nothing else — it cannot read a payment account. Since
[migration 0005](../database/migrations/0005_onboarding_identity.sql),
`enrollment` may only `INSERT`.

The values themselves come from `sessionContextFor()`
([`security.ts:58`](../backend/security.ts)), which reads `req.user` — the
verified JWT payload — and nothing else. No header, no query parameter, no
request body field feeds it. Routes get their handle from `scoped(req)`
([`routes.ts:71`](../backend/routes.ts)), so using the database at all means
declaring who you are.

## The policies, in one pass

Read policies as answers to "who is this row about?"

**Public by design.** `loads`, `settlements`, and `platform_config` are
`USING (true)` for `SELECT`. The ledger is public, and it joins settlements to
their loads; hiding those rows would defeat the product. Writes are scoped
normally.

The load board itself is narrower than the policy. `GET /api/loads` requires a
driver or admin token, and drivers only get open loads; a shipper reads their
own loads through `GET /api/shipper/loads`. That limit lives in the routes
(`requireRole`), not in RLS, because the ledger still needs every settled
load's row.

**Self, or admin.** `users`, `driver_profiles`, `shipper_profiles` are readable
by the row's own user, by an admin, and by the pre-auth contexts.

**Owning driver only.** `driver_payment_accounts`, `driver_documents`, and
`driver_equipment` require `driver_id = app_current_driver_id()`. Payment
accounts are the table the whole scheme exists to protect.

**Relationship-derived.** `bookings` are visible to the booked driver, to the
shipper who owns the load (via an `EXISTS` subquery), and to admins. A driver
cannot see another driver's bookings at all — which is why the booking route
answers "is this load taken?" from the load's own status rather than by scanning
`bookings`, since that scan would return nothing regardless.

**Nobody.** `audit_log` has a `SELECT` policy for admins, but the app role holds
no grant on the table, so in practice it is readable only through an owner
connection.

### RLS is row-scoped, not column-scoped

The load board wants to show which company posted a load. `shipper_profiles`
also holds `billing_email` and the owning `user_id`, and the policy correctly
hides those rows from anonymous visitors — so the join returned nothing.

Row-Level Security has no answer to "this column but not that one." The fix is
`public_shipper_view`
([`0003_public_shipper_view.sql`](../database/migrations/0003_public_shipper_view.sql)),
a two-column projection of `id` and `company_name`. It is owned by the schema
owner, so it reads past RLS on the base table — which is safe precisely because
the view cannot project anything else. The trick is only sound when the
projection is that narrow; widening it later would be a silent bypass.

## Two policies that record their own bugs

Migrations 0004 and 0005 exist because the original policy set was wrong in two
different ways, and both are worth knowing before editing anything here.

### A locking read is checked against the UPDATE policy

Booking a load starts with `SELECT ... FOR UPDATE` to serialize competing
drivers. In PostgreSQL a locking read is evaluated against the `UPDATE` policy as
well as the `SELECT` one — it is a write intent, and the database treats it as
one. The original `loads_update` policy required the caller to *already hold a
booking*, so an open load was invisible to the only driver who had a reason to
lock it. Every booking attempt failed with "Load not found."

[Migration 0004](../database/migrations/0004_load_claim_policy.sql) splits the
rule across `USING` and `WITH CHECK`, which is what the intent actually needed:
a driver may **lock** a load that is open or already theirs, and whatever they
**write** must leave them holding a live booking. Claiming therefore requires
having inserted your own booking row first — and `bookings_insert` already
restricts that to your own driver id. The two clauses close the loop on each
other.

### `FOR ALL` on the enrollment context

Migration 0002 granted `enrollment` a `FOR ALL` policy on the driver tables,
because signup needs to insert them. `FOR ALL` includes `UPDATE`. Combined with
an onboarding route that took an email in the request body and looked the driver
up by it, that meant anyone who knew a driver's email address could repoint that
driver's payout account at their own bank account. No authentication required —
the enrollment context is pre-identity by definition.

[Migration 0005](../database/migrations/0005_onboarding_identity.sql) splits every
`FOR ALL` into per-command policies: `enrollment` keeps `INSERT` and loses
`SELECT` and `UPDATE`, both of which now demand `driver_id =
app_current_driver_id()`. The route was fixed in the same change — onboarding
now runs as the authenticated driver and has no field naming a subject
([`routes.ts:662`](../backend/routes.ts)) — but the policy split is the part
that matters, because it means a future regression in that route cannot reach
the same outcome.

The general lesson the two migrations share: `FOR ALL` is a convenience that
grants more than the sentence you had in mind.

## Passwords, tokens, and throttling

**Storage.** bcrypt at cost 10, and `users_password_is_bcrypt` requires the
column to match `^\$2[aby]?\$[0-9]{2}\$` with length ≥ 55. A plaintext password
is not merely discouraged, it is unwritable — the wrong-shaped `INSERT` is
rejected by the database.

**Timing.** An unknown email is compared against `DUMMY_PASSWORD_HASH`
([`routes.ts:205`](../backend/routes.ts)), a real bcrypt digest of an
unguessable value, so both branches pay the same ~100ms. Without it, response
time answers "is this address registered?" for anyone who asks.

**Throttling.** `app_login_lockout_seconds()` and `app_record_login_attempt()`
([`0002_security.sql:284`](../database/migrations/0002_security.sql)) live in the
database: five failures in fifteen minutes locks the account, a success clears
the streak, and rows older than seven days are pruned on write. Migration 0028
scopes the count to the guessing address; see the limits below. In-process
counters would reset on deploy and would not be shared across instances behind a
load balancer; a database table survives both. The functions are
`SECURITY DEFINER` with a pinned `search_path`, so the app role can call them
without being able to read or edit the attempt log.

**Tokens.** `HS256` is pinned at both `sign` and `verify`
([`auth.ts:52`](../backend/auth.ts)), which is what blocks `alg: none` and
algorithm-confusion forgeries — a token that asks to be verified with a scheme
this server never issues is rejected rather than accommodated. In production
`JWT_SECRET` must exist and be at least 32 characters or the server refuses to
boot; development falls back to a fixed default with a warning, which keeps the
demo logins working and is exactly why that fallback must not survive into
production.

**Bank details.** `tokenizeBankAccount()`
([`security.ts:31`](../backend/security.ts)) is `HMAC-SHA256`, not an
encoding. The digest cannot be reversed, and without the secret it cannot be
recomputed from guessed account numbers either. The raw numbers are never
persisted or logged. Underneath, `payment_account_is_tokenized` rejects anything
matching `^[0-9-]{6,}$`, so a regression that skipped tokenization would fail at
the `INSERT` rather than quietly storing a bank account.

**Identifiers.** `newId()` uses `crypto.randomBytes(9)`. The earlier
`Date.now()`-based ids were guessable and could collide under concurrency;
knowing one booking id told you roughly what the next one would be, which is the
whole input to an insecure-direct-object-reference attack.

## The audit trail the application cannot touch

`audit_row_change()` ([`0002_security.sql:177`](../database/migrations/0002_security.sql))
fires `AFTER INSERT OR UPDATE OR DELETE` on `users`, `loads`, `bookings`,
`settlements`, `driver_payment_accounts`, and `platform_config`. It records the
acting `app_current_user_id()` and `app_current_role()` — the same
transaction-scoped settings RLS reads, so the audit trail and the access
decision cannot disagree about who was asking.

Two properties make it evidence rather than logging. It is `SECURITY DEFINER`
with `SET search_path = public, pg_temp`, so it writes as the owner and cannot
be redirected by a hostile schema on the search path — and the app role, holding
no grant on `audit_log`, can neither forge entries nor read them back. And
`audit_log_append_only` raises on `UPDATE` and `DELETE` for *every* role,
including the owner: history cannot be tidied.

Both `old_data` and `new_data` are `to_jsonb(...) - 'password_hash' -
'processor_account_id'`. An audit trail that faithfully captured every column
would become the single best place to steal secrets from, so the two that matter
are dropped at write time rather than filtered at read time.

## What this does not cover

Ranked by what would actually hurt.

**Anyone can create an admin account.** `signupSchema`
([`routes.ts:112`](../backend/routes.ts)) accepts `role: z.enum(['driver',
'shipper', 'admin'])`, and the route creates the user with whatever role the
body asked for and returns a signed token for it. A single unauthenticated
`POST /api/auth/signup` with `"role": "admin"` yields a credential that
`app_is_admin()` honours in nearly every policy in the schema, and that opens
`GET /api/admin/ledger` — every settlement joined to driver full names and CDL
numbers ([`routes.ts:783`](../backend/routes.ts)) — plus
`GET /api/admin/export`. It also permits completing any booking and inserting
settlements against bookings the caller does not own.

Nothing downstream mitigates it, because every layer below correctly trusts the
role claim: RLS was told this is an admin, and it believes the thing it was
designed to believe. The fix belongs at the top — drop `admin` from the signup
enum and provision admins out of band. The audit trail does record the account
creation, which is how you would find out afterward.

**The PGlite fallback connects as a superuser**, which bypasses RLS entirely by
design. Policies are the thing most likely to be wrong, and the zero-setup
development path is the one where they are not exercised at all. Develop against
a real PostgreSQL server whenever you touch `0002`–`0005`; `npm run db:up` makes
that a one-liner.

**Sessions cannot be revoked.** Tokens are `7d` and stateless, stored in
`localStorage`, and there is no denylist. A leaked token is valid for its full
week, and a role change does not take effect until the holder signs in again.
`localStorage` also means any successful XSS reads the token directly — the
`X-Frame-Options`, `nosniff`, and `Referrer-Policy` baseline in
[`backend/server.ts:22`](../backend/server.ts) does not include a CSP on the application HTML,
because Vite's dev server needs inline scripts.

**A distributed attacker can still lock a named account.** Lockout follows who
is guessing ([`0028`](../database/migrations/0028_lockout_scope_and_private_uploads.sql)):
five failures for one email from one address, twenty from one address across
any emails, and a ceiling of fifty for one email from anywhere. One address can
no longer lock someone else out, but fifty guesses spread over several addresses
inside fifteen minutes still can. There is no password reset to recover with.

**The client address is only as good as the proxy configuration.** Rate limits
and the lockout above use `clientIp()` ([`security.ts`](../backend/security.ts)),
which reads `CLIENT_IP_HEADER` when set and otherwise the entry `TRUST_PROXY`
hops from the right of `X-Forwarded-For`. If the hop count is too low, every
caller shares the proxy's address and one bucket; if `CLIENT_IP_HEADER` names a
header the edge does not overwrite, callers choose their own address.

**No CSRF tokens and no rate limiting outside login.** The API is
JWT-in-header rather than cookie-based, so it is not cross-site forgeable today
— but that is a property of the current client, not an enforced invariant, and
it would quietly stop being true the day anything moves to a cookie.

**Uploaded documents are readable only by their uploader and admins.**
`/uploads/doc-...` requires a sign-in token and returns the file only to the
account that uploaded it or to an admin (`app_get_own_upload`, migration 0028).
Nobody else has a route to a driver's documents, including a shipper who has
booked that driver. See
[ONBOARDING.md](ONBOARDING.md#documents-are-uploaded-verified-and-then-dropped).
