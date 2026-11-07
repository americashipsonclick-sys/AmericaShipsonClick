# Settlement — how a load becomes money

Every number the public ledger publishes is decided in one place: the
`PATCH /api/bookings/:id/complete` transaction in
[`backend/routes.ts:504`](../backend/routes.ts). Nothing the browser sends
is trusted to price a load. The request body for that endpoint is empty — the
route reads the booking, the load, and the current rates for itself, computes
gross, factor, and net, and writes a settlement row that the database
then refuses to let anyone change. A driver can no more talk the server into a
larger payout than a shipper can talk it into a smaller one, because neither of
them is asked.

## The numbers

A settlement is one subtraction off one product:

```
gross  = miles x rate_per_mile
factor = gross x factor_pct  (or 0)      cost of same-day funding
net    = gross - factor                  what the carrier takes home
```

The platform takes no fee. [`0025_remove_platform_fee.sql`](../database/migrations/0025_remove_platform_fee.sql)
removed it for new settlements. Past rows keep the fee they were charged, because
that money really moved and the ledger is append-only. The settlement also used to
subtract a modeled fuel cost; [`0023_drop_fuel.sql`](../database/migrations/0023_drop_fuel.sql)
removed it and added it back into every past row's net, since nobody ever collected it.

## Where the rates come from

`factor_pct` (0.03) and `broker_comparison_pct` (0.20) are rows in `platform_config`, seeded by
[`0001_initial_schema.sql:171`](../database/migrations/0001_initial_schema.sql).
They are not constants in code, not environment variables, and not duplicated
per load. Changing a rate is an `UPDATE` against one row.

Both the server and the browser read them from the same table — the browser via
`GET /api/config` ([`routes.ts:90`](../backend/routes.ts)), the settlement
path via a direct `SELECT` inside its own transaction
([`routes.ts:538`](../backend/routes.ts)). Every read site carries the same
`?? 0.03` fallback, so a missing config row degrades to
the seeded default instead of writing `NaN` into the ledger. The fallback is
written out across `routes.ts`, `seed.ts`, and `settlementPreview.ts`; they agree
today, and nothing enforces that they keep agreeing.

`broker_comparison_pct` drives the broker side of the homepage comparison.

## Past fees stay on their rows

`settlements` keeps `fee_amount` and `fee_pct_applied` as history. New settlements
leave them at their default of 0. A row settled at 5% or 7% still carries the rate
and the dollars it was charged, so `gross_amount`, `fee_amount`, and
`fee_pct_applied` remain checkable arithmetic with no knowledge of what the platform
charges now. Open Books and the dashboards show a fee column only when the rows
they list include a non-zero fee.

## Who decides the factor cost

Same-day funding is offered by the shipper and opted into by the driver, and at
settlement the driver's standing preference wins:

```ts
const factored = drvPayRes.rows[0]?.same_day_funding_opt_in
              ?? load.same_day_funding_offered;
```

The load's `same_day_funding_offered` flag is a fallback for drivers with no
`driver_payment_accounts` row — not a veto and not a requirement. A driver who
opted into quick pay is factored even on a load that did not advertise it, and a
driver who did not is not factored on a load that did. That is the right default
for the carrier, whose cash-flow needs do not change lane by lane, but it means
the shipper's own preview of the factor line is a guess about someone else's
settings.

The load board and load detail apply the same rule through `isFactored()`, using
the signed-in driver's preference from `GET /auth/me`, so "You keep" matches what
that driver is paid. New drivers start opted out and choose quick pay themselves
during onboarding.

## The estimates match the ledger

Three places in the product show a carrier's take-home, and all of them use the
ledger's formula through `settlementPreview`
([`frontend/src/lib/settlementPreview.ts`](../frontend/src/lib/settlementPreview.ts)):

| Where | Formula | 780 mi @ $2.15 |
| --- | --- | --- |
| Load board card ([`FindLoads.tsx`](../frontend/src/pages/FindLoads.tsx)) | `gross - factor` | **$1,677.00** (or $1,626.69 with quick pay) |
| Post-a-load calculator ([`PostLoad.tsx`](../frontend/src/pages/PostLoad.tsx)) | `gross - factor` | **$1,677.00** (or $1,626.69 with quick pay) |
| Settlement ([`routes.ts`](../backend/routes.ts)) | `gross - factor` | **$1,677.00** (or $1,626.69 factored) |

The one figure a preview can get wrong is the factor line, since the driver's
own quick-pay setting decides it at settlement (see above).

## The database's own opinion of the arithmetic

Application code can be wrong. `settlements_math_balances`
([`0023_drop_fuel.sql`](../database/migrations/0023_drop_fuel.sql)) makes the
wrong answer unwritable:

```sql
CHECK (
  abs(net_amount - (gross_amount - fee_amount - factor_cost)) < 0.01
  AND abs(gross_amount - (miles * rate_per_mile)) < 0.01
)
```

A settlement whose net does not follow from its own components is rejected —
including one written by the owner role, by a migration, or by hand in `psql`.
The fee term is 0 on new settlements and still balances past rows. Alongside it,
`settlements_non_negative` refuses negative money and `settlements_fee_pct_sane`
caps the applied fee at 50%, so a stray decimal cannot mint a row claiming the
platform took 500%.

The one-cent tolerance exists because the math is done in JavaScript doubles and
compared against Postgres `NUMERIC`. It is a rounding allowance, not a fudge
factor — nothing legitimate lands inside it, and a mistyped formula misses by
dollars.

## Amounts are stored unrounded

Nothing rounds to cents before the `INSERT`. `780 * 2.15 * 0.03` is
`50.309999999999995` in IEEE 754, and the columns are unconstrained `NUMERIC`, so
that is what the ledger holds. Every display path applies `.toFixed(2)`, so it
is invisible in the UI and in the CSV export, and the balance CHECK tolerates it
by design. It surfaces in two places: raw `SELECT`s against `settlements`, and
`settlement_totals_view`, where the residue sums across every row. Rounding each
component to cents at write time would remove it, at the cost of a migration for
existing rows.

## Exactly one driver, exactly one settlement

The money math only makes sense if a load is hauled once. Booking
([`routes.ts:419`](../backend/routes.ts)) defends that three times over,
inside a single transaction on a single pooled connection — which is the point of
`db.transaction()`, since `FOR UPDATE` holds its lock only for statements issued
on the same client, and a `BEGIN` on a shared pool handle would not be atomic at
all:

1. An unlocked read separates "no such load" (404) from "already taken" (409), so
   a losing driver gets an accurate answer rather than a generic one.
2. `SELECT ... WHERE status = 'open' FOR UPDATE` blocks behind any competing
   booking and re-checks the status afterward. Exactly one caller leaves that
   line holding the row.
3. A partial unique index, `idx_unique_active_booking ON bookings (load_id)
   WHERE status NOT IN ('cancelled')`
   ([`0001_initial_schema.sql:143`](../database/migrations/0001_initial_schema.sql)),
   makes a second live booking unrepresentable even if both application checks
   were removed. The `23505` handler turns it back into the same 409. Cancelled
   bookings are excluded, so a released load can be booked again.

Completion is guarded the same way. The booking row is taken `FOR UPDATE`, only
the booked driver or an admin may trigger it, an already-completed booking is
refused, and the settlement `INSERT` plus both parent status updates commit
together. A settlement for a booking that was never marked completed cannot
exist, and neither can the reverse.

The SSE broadcast fires *after* `COMMIT`
([`routes.ts:579`](../backend/routes.ts)). Open Books subscribers therefore
never see a settlement that a rollback later erased.

## Written once, then frozen

`settlements` is append-only: the `settlements_append_only` trigger
([`0002_security.sql:243`](../database/migrations/0002_security.sql)) raises on
`UPDATE` and `DELETE` for every role, owner included, and the application role
holds only `SELECT, INSERT`. Both parents are `ON DELETE RESTRICT`, so the load
and booking a settlement refers to cannot be deleted out from under it. Every
write is recorded in `audit_log` by a `SECURITY DEFINER` trigger the application
can neither forge nor read back.

A published payout is a claim the platform cannot quietly retract. Correcting one
means writing a new row, not editing the old one.

## Totals are queried, never counted

The headline figures come from `settlement_totals_view`, a plain (not
materialized) aggregate over `settlements`, read at
[`routes.ts:615`](../backend/routes.ts). Nothing increments a counter
anywhere, so no cache can drift from the rows and no missed SSE event can leave a
stale total on a dashboard. Every read is the sum as of that instant; the cost is
a full aggregate per request, which is fine at ledger sizes and would want a
materialized view long before it stopped being.

The public ledger itself is `public_ledger_view`, which joins settlements to
loads for lane and equipment and stops there — no driver id, no shipper id, no
company name. Open Books publishes what a lane paid, not who hauled it.
