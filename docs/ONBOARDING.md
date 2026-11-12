# Drive With Us — the four steps, and what each one actually persists

The carrier onboarding wizard ([`frontend/src/pages/DriveWithUs.tsx`](../frontend/src/pages/DriveWithUs.tsx),
970 lines) collects a driver's profile, licence numbers, equipment, and payout
details across four screens, auto-saving as they type. Two of its decisions are
load-bearing and non-obvious, and three of the things it displays are not real
yet. This document covers both, because a reader who knows only the first half
will trust the screen.

## The account is created at step 1, not step 4

A wizard that submits everything at the end is the obvious design, and it does
not work here. Step 2 uploads a CDL photo and a DOT authority letter, and
`POST /api/uploads/file` requires a token
([`routes.ts:746`](../backend/routes.ts)) — leaving it unauthenticated would
let anyone fill the server's disk 10 MB at a time. So step 1 calls
`api.signup()` before advancing ([`DriveWithUs.tsx:282`](../frontend/src/pages/DriveWithUs.tsx)),
and every later request in the wizard is authenticated.

The alternative — issue a shared pre-auth upload token — was avoided, and the
side benefit is that the driver picks their own password rather than being
handed a placeholder to change later. The cost is that abandoning the wizard at
step 3 leaves a real account with a half-filled profile, and re-entering the
wizard with that email produces "An account with this email already exists. Sign
in first, then finish onboarding." rather than a resume. `accountCreated` guards
against a second signup within one session, but it lives in component state, so
a page refresh loses it — the draft resumes, the flag does not, and the retry is
what surfaces that message.

## What the draft keeps, and what it refuses to

`formData` is mirrored into `localStorage` on every keystroke
([`DriveWithUs.tsx:9`](../frontend/src/pages/DriveWithUs.tsx)), which is what makes
progress survive a refresh. That makes the shape of `formData` a security
decision rather than a convenience:

- **The password is not in `formData` at all.** It lives in its own `useState`
  ([`DriveWithUs.tsx:30`](../frontend/src/pages/DriveWithUs.tsx)) and is cleared the
  moment signup succeeds. A resumable draft is the wrong place for a credential.
- **Bank details are stripped on write.** `persistDraft()` deletes
  `routing_number` and `account_number` before serializing
  ([`DriveWithUs.tsx:16`](../frontend/src/pages/DriveWithUs.tsx)). They are transient by
  design: typed at step 4, tokenized server-side on submit, never at rest in the
  browser. Any script running on the origin can read `localStorage`, so "we only
  keep it until submit" is not a safe answer for a routing number.

Everything else — name, city, licence numbers, equipment, uploaded document URLs
— is persisted in the clear and restored on mount.

## The identity rule

`POST /api/drivers/onboard` ([`routes.ts:662`](../backend/routes.ts)) has no
field naming a subject. Not an email, not a driver id. The profile is located by
`SELECT id FROM driver_profiles WHERE user_id = $1` with the id from the verified
token, and every statement runs under `sessionContextFor(req)` so RLS scopes the
writes to that driver regardless of what the body asked for.

This is deliberate and recent. An earlier version accepted an email, looked the
user up by it, and upserted their payment account — so anyone who knew a
driver's email address could point that driver's settlements at their own bank.
The route was fixed and
[migration 0005](../database/migrations/0005_onboarding_identity.sql) removed the
`UPDATE` privilege that made it possible, so the same regression cannot produce
the same outcome twice. The submit handler mirrors the rule on the client,
destructuring `email` and `phone` out of the payload before sending
([`DriveWithUs.tsx:335`](../frontend/src/pages/DriveWithUs.tsx)).

Contact phone is recorded on the `users` row at signup and never updated here,
because `users` is granted `SELECT, INSERT` only — the application has no way to
rewrite a user row, which is the same grant that makes a password hash or a role
unwritable. Changing a phone number would need a new route and a widened grant.

## Payout details

Both halves or neither: supplying one of `routing_number` / `account_number`
without the other is a 400, since a token derived from half the material would
be a stable-looking value that identifies nothing. When both are present,
`tokenizeBankAccount()` runs *before* any statement executes, so the raw numbers
never reach a query — see
[SECURITY.md](SECURITY.md#passwords-tokens-and-throttling) for why it is an HMAC
rather than an encoding.

When neither is present the route still applies `same_day_funding_opt_in` with a
plain `UPDATE`, so a driver can change their quick-pay preference later without
re-entering bank details. That flag is what decides the 3% factor line at
settlement, and the driver's stored preference outranks the load's offer —
[SETTLEMENT.md](SETTLEMENT.md#who-decides-the-factor-cost) has the precedence
rule.

The response returns `payment_account_last4`, derived from the raw account
number in memory and never stored. It exists so the UI can confirm *which*
account was saved without the platform retaining anything that identifies it.

### Deterministic ids, and the upsert that depends on them

Equipment and payment rows use `'eq-' + driverId` and `'pay-' + driverId` rather
than `newId()`, at both signup ([`routes.ts:149`](../backend/routes.ts)) and
onboarding. That is what makes `ON CONFLICT (id) DO UPDATE` work as an idempotent
"one rig, one payout account per driver" upsert: re-running onboarding overwrites
in place instead of accumulating rows.

It also fixes the schema at one of each. A driver with two trailers has no
representation today, even though `driver_equipment` is modelled as a `1:N`
relationship in [ERD.md](ERD.md) and the grants allow the inserts. Supporting a
second rig means giving up the deterministic id and replacing the upsert with an
explicit match — worth knowing before treating the `1:N` on the diagram as a
capability.

## Documents are uploaded, "verified", and then dropped

Steps 2 and 3 require three uploads — CDL photo, DOT authority letter,
Certificate of Insurance — and `validateStep2` / `validateStep3` block progress
without them ([`DriveWithUs.tsx:213`](../frontend/src/pages/DriveWithUs.tsx)). Each one
posts to `/api/uploads/file`, which stores the bytes under a generated name with
an extension taken from a MIME allowlist (PNG/JPEG/WebP/PDF, 10 MB, one file per
request) and returns a `/uploads/doc-...` URL.

That URL goes into `formData`, into the `localStorage` draft — and no further.
The submit handler destructures `cdl_photo_url`, `dot_authority_url`, and
`coi_url` out of the payload ([`DriveWithUs.tsx:335`](../frontend/src/pages/DriveWithUs.tsx)),
`driverOnboardSchema` has no fields for them
([`routes.ts:634`](../backend/routes.ts)), and the route never writes to
`driver_documents`. Nothing in the application does: outside the migrations, the
table name does not appear in the application code at all.

So the table exists, with a `doc_type` enum, RLS policies, and grants — and it is
always empty. The files sit in `uploads/` indefinitely with no row pointing at
them, and `localStorage.removeItem()` on success discards the last reference the
system had. An admin reviewing a carrier has no way to find the CDL they were
required to upload.

The files are served from `/uploads` with `Content-Disposition: attachment` and
a `sandbox` CSP ([`backend/routes.ts`](../backend/routes.ts), `serveUpload`),
which stops an uploaded document from executing in the app's origin. The path
requires a sign-in token and returns a file only to the account that uploaded
it or to an admin (migration 0028).

Closing this needs three things: document URLs in the onboard schema, an
`INSERT` into `driver_documents` inside the existing transaction, and an
authenticated route to read a document back.

## The verification theatre

Three things on these screens announce a check that does not happen.

**FMCSA lookup.** `runFmcsaVerification()`
([`DriveWithUs.tsx:157`](../frontend/src/pages/DriveWithUs.tsx)) validates that the USDOT
number is at least 5 characters, waits one second on a `setTimeout`, and then
sets `fmcsaVerified = true` with a fabricated carrier name (the driver's own name
plus `" LOGISTICS LLC"`), `dotStatus: 'ACTIVE - AUTHORIZED FOR HIRE'`,
`safetyRating: 'SATISFACTORY'`, and `inspectionPassRate: '98.8%'`. There is no
request. Every USDOT number that clears the length check passes, including one
that does not exist.

Worse for a returning user: restoring a draft that contains any `dot_number`
replays the whole verified state on mount ([`DriveWithUs.tsx:79`](../frontend/src/pages/DriveWithUs.tsx))
without even the one-second pause — so the screen shows a satisfactory safety
rating for a carrier nobody ever looked up.

**OCR document scanning.** `handleFileUpload()` shows "Scanning document with
OCR…", and 600 ms after the upload resolves it prints a per-field result:
"✓ Verified: Valid State-Issued CDL Class A detected", "USDOT Interstate
Authority Letter Validated", "$1,000,000 Liability & $100,000 Cargo Active
Policy". The file was stored; nothing read it. The CDL class in that message is
the value the driver typed into the form, echoed back as though it had been
extracted from the image.

**`verification_status`.** Signup inserts driver profiles as `'verified'`
outright ([`routes.ts:149`](../backend/routes.ts)), and onboarding's `UPDATE`
does not touch the column. The `pending | verified | rejected` enum therefore
only ever holds one value in practice, and the review step it implies does not
exist — which is also why migration 0005 could drop the
`verification_status = 'pending'` clause from the enrollment policy without
changing any behavior.

None of this is a bug in the code as written; it is a demo standing where an
integration goes. It is worth stating plainly because the page presents it as
settled fact — the header stamp reads "✓ INSTANT CARRIER VERIFICATION", and a
shipper handing freight to a carrier reasonably reads that as a claim about the
carrier rather than about the animation. A real implementation calls the FMCSA
QCMobile API for the DOT number, runs OCR or a human review over the stored
documents, and leaves `verification_status` at `'pending'` until one of those
returns.
