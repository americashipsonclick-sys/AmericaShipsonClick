-- The Open Books platform fee is removed. Carriers keep gross minus any
-- same-day funding cost.
--
-- Past settlements keep their fee_amount and fee_pct_applied. Unlike the modeled
-- fuel cost dropped in 0023, those fees were really charged, so the ledger still
-- records them and settlements_math_balances still holds for every row.
--
-- This is separate from `quote_gross_pct` (migration 0016), the 7% adder on the
-- shipper's quote, which is unchanged.

DELETE FROM platform_config WHERE key = 'fee_pct';

ALTER TABLE settlements ALTER COLUMN fee_amount SET DEFAULT 0;
ALTER TABLE settlements ALTER COLUMN fee_pct_applied SET DEFAULT 0;
