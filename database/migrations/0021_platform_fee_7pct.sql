-- The Open Books platform fee moves from 5% to 7% of gross.
--
-- `platform_config.fee_pct` is the one value GET /api/config serves and
-- PATCH /bookings/:id/complete applies. Settlements already written keep
-- their `fee_pct_applied`, so the ledger still shows 5% on past loads.
--
-- This is separate from `quote_gross_pct` (migration 0016), the 7% adder on
-- the shipper's quote.

UPDATE platform_config
SET value = 0.07, updated_at = CURRENT_TIMESTAMP
WHERE key = 'fee_pct';
