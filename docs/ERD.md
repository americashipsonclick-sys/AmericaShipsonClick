# Entity Relationship Diagram — America Ships On Click

The schema is the product rules, not a sketch of them. Open Books arithmetic,
double-booking, admin self-serve, the 30-day sell lock, the 1×/5× holder split,
and the 0.7% holder cap are all CHECK constraints or triggers. A route that
forgets a rule still cannot write a row that breaks it.

Spec locked 2026-09-10. Phase 1 tables (webhook, wallets, stake, hourly bonus)
are live in the database. Phase 2 haul receipts exist as empty, constrained
tables. Messaging and email are not in this database yet.

## Domains

| Domain | Tables | What the database decides |
| --- | --- | --- |
| Identity | `users`, `user_google_identities`, `driver_profiles`, `shipper_profiles`, `driver_documents`, `driver_equipment`, `driver_payment_accounts`, `verification_reviews` | Who may act. Admin cannot be self-served. A carrier cannot mark themselves verified. |
| Freight | `loads`, `load_photos`, `bookings`, `booking_locations`, `load_events`, `load_offers` | One live booking per load. Illegal status jumps are rejected. Offers accept atomically. GPS points come only from the booked driver while the trip is active, and reaching a stop logs the arrival once. A load has at most three photos, changed only by its shipper or an admin while it is open. |
| Open Books | `settlements`, `settlement_disputes`, `settlement_adjustments`, `platform_config` | `net = gross − fee − factor`. Settlements are append-only. Corrections are additive. |
| Ops | `refresh_tokens`, `password_reset_tokens`, `idempotency_keys`, `api_rate_limits`, `auth_login_attempts`, `audit_log`, `notifications`, `notification_preferences`, `ratings` | Sessions, throttles, and reputation survive restarts. |
| Phase 1 token | `wallets`, `chain_contracts`, `webhook_receipts`, `contract_events`, `token_buys`, `token_positions`, `app_memberships`, `premium_attestations`, `hourly_epochs`, `transaction_reserves`, `hourly_claims`, `driver_payouts` | Buy-in, 30-day lock, 1× vs 5× never stacked, holder claims cannot exceed 7% of the 10% reserve. Driver payouts are USDC on Base only. |
| Phase 2 (empty) | `haul_receipts` | Same receipt will carry plate, load id, miles, rate, reserve. Nothing writes it yet. |

## Freight marketplace

```mermaid
erDiagram
    users ||--o| user_google_identities : "1:1 Google login"
    users ||--o| driver_profiles : "1:1"
    users ||--o| shipper_profiles : "1:1"
    users ||--o{ ratings : "rates"
    users ||--o{ notifications : "inbox"

    driver_profiles ||--o{ driver_documents : "1:N"
    driver_profiles ||--o{ driver_equipment : "1:N"
    driver_profiles ||--o| driver_payment_accounts : "1:1"
    driver_profiles ||--o{ bookings : "hauls"
    driver_profiles ||--o{ load_offers : "bids"
    driver_profiles ||--o{ verification_reviews : "reviewed"

    shipper_profiles ||--o{ loads : "posts"

    loads ||--o{ load_photos : "pictured by"
    uploaded_files ||--o| load_photos : "bytes"
    loads ||--o{ bookings : "claimed by"
    loads ||--o{ load_events : "timeline"
    loads ||--o{ load_offers : "bids"
    loads ||--o{ settlements : "ledgered"

    bookings ||--o| settlements : "1:1"
    bookings ||--o{ booking_locations : "tracked"
    bookings ||--o{ ratings : "earned"

    settlements ||--o{ settlement_disputes : "challenged"
    settlements ||--o{ settlement_adjustments : "corrected"
    settlement_disputes ||--o{ settlement_adjustments : "resolution"

    users {
        text id PK
        user_role role "driver shipper admin"
        text email UK
        text password_hash "bcrypt or null; admin required"
    }

    user_google_identities {
        text id PK
        text google_sub UK
        text user_id FK,UK
        text email "as reported at link time"
    }

    loads {
        text id PK
        text shipper_id FK
        numeric miles
        numeric rate_per_mile
        load_status status "open booked in_transit delivered cancelled"
        numeric origin_lat "nullable pin"
        numeric dest_lat "nullable pin"
        text origin_street "nullable dock / street"
        text origin_zip "nullable 5-digit ZIP"
        text origin_address "nullable full pickup label"
        text load_type "nullable full_truckload partial"
        text pickup_appt_start "nullable HH:MM"
        text pickup_dock "nullable"
        text delivery_date "nullable"
        integer pallets "nullable"
        text commodity "nullable"
        boolean hazmat "null means not stated"
        boolean requires_twic
        text payment_terms "nullable, shipper's words"
    }

    load_photos {
        text id PK
        text load_id FK
        text file_id FK,UK "uploaded_files; never sent to clients"
        text caption "nullable"
        timestamptz created_at
    }

    uploaded_files {
        text id PK
        text content_type
        integer size_bytes
        bytea data
    }

    bookings {
        text id PK
        text load_id FK "unique while not cancelled"
        text driver_id FK
        numeric agreed_rate_per_mile "offer wins over posted"
        booking_status status
        timestamptz picked_up_at "set by the driver; load goes in_transit"
    }

    booking_locations {
        text booking_id PK,FK
        timestamptz recorded_at PK "phone's clock; resends are skipped"
        float lat
        float lng
        real speed_mps
        real heading_deg
    }

    settlements {
        text id PK
        text booking_id FK UK
        numeric gross_amount "miles x rate"
        numeric net_amount "gross - fee - factor"
        timestamptz settled_at
    }
```

## Phase 1 token, holders, and USDC payouts

```mermaid
erDiagram
    users ||--o{ wallets : "may link"
    users ||--o{ app_memberships : "premium"
    users ||--o{ premium_attestations : "attests"

    app_memberships ||--o{ premium_attestations : "source"
    wallets ||--o| token_positions : "1:1"
    wallets ||--o{ token_buys : "buy-in"
    wallets ||--o{ premium_attestations : "5x weight"
    wallets ||--o{ hourly_claims : "bonus"
    wallets ||--o{ driver_payouts : "USDC Base"

    webhook_receipts ||--o{ contract_events : "decoded"
    hourly_epochs ||--o{ transaction_reserves : "0.7 percent slice"
    hourly_epochs ||--o{ hourly_claims : "haircut to slice"

    settlements ||--o| driver_payouts : "separate pipe"
    settlements ||--o| haul_receipts : "Phase 2"

    wallets {
        text id PK
        text user_id FK "nullable until linked"
        int chain_id "8453 Base only"
        text address UK "0x plus 40 hex"
    }

    token_buys {
        text id PK
        text wallet_id FK
        numeric amount "greater than 0, no minimum"
        timestamptz lock_until "bought_at plus 30 days"
    }

    token_positions {
        text wallet_id PK FK
        numeric staked_balance "0 unless first_buy_at set"
        timestamptz sell_locked_until
    }

    premium_attestations {
        text id PK
        text membership_id FK "paid app membership, no burn"
        text wallet_id FK "one live per wallet"
        text on_chain_tx "null until attested on chain"
    }

    transaction_reserves {
        text id PK
        numeric volume
        numeric reserve_amount "volume x 0.10"
        numeric holder_slice "reserve x 0.07"
        text epoch_id FK
    }

    hourly_claims {
        text id PK
        text epoch_id FK
        int weight_multiplier "1 or 5, never both"
        numeric paid_amount "capped by epoch holder_pool"
    }

    driver_payouts {
        text id PK
        text settlement_id FK UK
        text token "USDC only"
        int chain_id "8453 only"
    }

    haul_receipts {
        text id PK
        text settlement_id FK UK
        text plate "Phase 2"
        numeric reserve_amount "same 10 percent rule"
    }
```

## Money split (holder rewards)

Per unit of volume the database will accept:

| Slice | Share of volume | Rule |
| --- | --- | --- |
| Transaction reserve | 10% | `reserve_amount = volume × 0.10` |
| Holder pool (from that reserve) | 0.7% of volume | `holder_slice = reserve_amount × 0.07` — the only money hourly claims may draw |
| Remainder of reserve | 9.3% of volume | Not a holder reward. Not mixed into driver USDC payouts. |
| Open Books platform fee | 7% of gross | Separate pipe. `settlements.fee_pct_applied`. |
| Driver payout | settlement net | USDC on Base. `driver_payouts`. Never the holder pool. |

Hourly bonus weights: regular = 1× staked balance, premium = 5× instead (never 6×). If the sum of naive claims exceeds that hour's `holder_pool`, each claim is multiplied by `haircut_ratio ≤ 1`. The insert trigger refuses any claim that would push `sum(paid_amount)` over the pool.

## Views

| View | Scope | Purpose |
| --- | --- | --- |
| `public_ledger_view` | Public | Settlements joined to lanes, no identities |
| `settlement_totals_view` | Public | Real aggregates, never counters |
| `settlement_effective_view` | Public | Original net plus adjustments |
| `public_shipper_view` | Public | Company name, member-since date and loads posted, so the board can join past billing RLS |
| `driver_reputation_view` / `shipper_reputation_view` | Public aggregates | Scores without rater identity |
| `driver_earnings_view` / `shipper_spend_view` | Self-scoping | Identity filter lives in the view |
| `lane_rate_stats_view` | Public, n ≥ 3 | Lane pricing that cannot dox a thin shipper |
| `load_board_stats_view` | Public | Open / booked / in-transit counts |
| `hourly_epoch_view` | Public | Holder pool vs paid vs unclaimed |
| `wallet_holder_view` | Self-scoping | Stake, lock, 1×/5× for the caller |

## Append-only tables

`settlements`, `audit_log`, `load_events`, `verification_reviews`, `settlement_adjustments`, `webhook_receipts`, `contract_events`, `token_buys`, `transaction_reserves`, `hourly_claims`, `haul_receipts`.

`UPDATE` and `DELETE` are refused by trigger even for the table owner.
