-- Open loads priced with the 7% gross adder drop to what the quote comes to
-- without it, so the board does not show two prices for the same lane.
--
-- Only an open load still at its logged quoted rate moves. A rate the shipper
-- typed in (overridden), a load booked or past that, and a load whose rate no
-- longer matches its quote are all left alone. The total is rebuilt from the
-- logged breakdown as migration 0026's quote math would: after_express, floored
-- at the distance minimum. audit_loads records every changed row, and rate_quotes
-- keeps what was originally quoted.

WITH latest_quote AS (
  SELECT DISTINCT ON (load_id)
    load_id, miles, overridden, posted_rate_per_mile, breakdown
  FROM rate_quotes
  WHERE load_id IS NOT NULL
  ORDER BY load_id, created_at DESC
)
UPDATE loads l
SET rate_per_mile = ROUND(
  GREATEST(
    (q.breakdown->>'after_express')::NUMERIC,
    COALESCE((q.breakdown->>'minimum_floor')::NUMERIC, 0)
  ) / l.miles,
  4
)
FROM latest_quote q
WHERE q.load_id = l.id
  AND l.status = 'open'
  AND NOT q.overridden
  AND l.rate_per_mile = q.posted_rate_per_mile
  AND l.miles = q.miles
  AND (q.breakdown->>'gross_markup')::NUMERIC > 0
  AND (q.breakdown->>'after_express')::NUMERIC > 0;
