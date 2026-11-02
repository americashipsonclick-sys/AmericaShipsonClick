-- Fuel comes out of the platform entirely.
--
--   * Settlements: net is now gross - fee - factor. The modeled fuel cost was
--     never money anyone collected, so each past settlement's fuel_cost is
--     added back into its net_amount and both fuel columns are dropped. Every
--     row still balances under the rewritten settlements_math_balances check.
--   * Quotes: the diesel-moving fuel surcharge is gone, so the diesel index,
--     diesel_base_ppg, each rate card's fuel_mpg, and rate_quotes.diesel_ppg
--     are dropped. Logged quote breakdowns (JSONB) keep whatever they recorded.
--   * Disputes: 'fuel' is no longer a category; open ones move to 'other'.

-- ---------------------------------------------------------------------------
-- 1. VIEWS THAT READ THE FUEL COLUMNS
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public_ledger_view;
DROP VIEW IF EXISTS settlement_effective_view;
DROP VIEW IF EXISTS settlement_totals_view;
DROP VIEW IF EXISTS driver_earnings_view;

-- ---------------------------------------------------------------------------
-- 2. SETTLEMENTS
-- ---------------------------------------------------------------------------
-- The ledger is append-only, so the one-time correction runs with the guard
-- lifted. The audit trigger stays on and records every changed row.

ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_math_balances;
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_non_negative;

ALTER TABLE settlements DISABLE TRIGGER settlements_append_only;
UPDATE settlements SET net_amount = net_amount + fuel_cost WHERE fuel_cost <> 0;
ALTER TABLE settlements ENABLE TRIGGER settlements_append_only;

ALTER TABLE settlements DROP COLUMN IF EXISTS fuel_cost;
ALTER TABLE settlements DROP COLUMN IF EXISTS fuel_rate_per_mile;

ALTER TABLE settlements ADD CONSTRAINT settlements_non_negative
  CHECK (miles > 0 AND rate_per_mile > 0 AND gross_amount >= 0 AND fee_amount >= 0
         AND factor_cost >= 0);

-- The Open Books guarantee: net is exactly gross - fee - factor, and gross is
-- exactly miles x rate.
ALTER TABLE settlements ADD CONSTRAINT settlements_math_balances
  CHECK (
    abs(net_amount - (gross_amount - fee_amount - factor_cost)) < 0.01
    AND abs(gross_amount - (miles * rate_per_mile)) < 0.01
  );

DELETE FROM platform_config WHERE key IN ('fuel_rate_per_mile', 'diesel_base_ppg');

-- ---------------------------------------------------------------------------
-- 3. QUOTES
-- ---------------------------------------------------------------------------

ALTER TABLE equipment_rate_cards DROP COLUMN IF EXISTS fuel_mpg;
ALTER TABLE rate_quotes DROP COLUMN IF EXISTS diesel_ppg;
DROP TABLE IF EXISTS diesel_prices;

-- ---------------------------------------------------------------------------
-- 4. DISPUTES
-- ---------------------------------------------------------------------------

ALTER TABLE settlement_disputes DROP CONSTRAINT IF EXISTS settlement_disputes_category_check;
UPDATE settlement_disputes SET category = 'other' WHERE category = 'fuel';
ALTER TABLE settlement_disputes ADD CONSTRAINT settlement_disputes_category_check
  CHECK (category IN ('rate', 'miles', 'detention', 'damage', 'fee', 'other'));

-- ---------------------------------------------------------------------------
-- 5. VIEWS, REBUILT WITHOUT FUEL
-- ---------------------------------------------------------------------------

CREATE VIEW public_ledger_view AS
SELECT
  s.id, s.load_id,
  l.origin_city, l.origin_state, l.dest_city, l.dest_state, l.equipment_type,
  s.miles, s.rate_per_mile,
  s.gross_amount, s.fee_amount, s.fee_pct_applied, s.factor_cost,
  s.factored, s.net_amount, s.settled_at
FROM settlements s
JOIN loads l ON s.load_id = l.id
ORDER BY s.settled_at DESC;

CREATE VIEW settlement_totals_view AS
SELECT
  COUNT(*)::INTEGER AS count,
  COALESCE(SUM(miles), 0)::NUMERIC AS miles,
  COALESCE(SUM(gross_amount), 0)::NUMERIC AS gross,
  COALESCE(SUM(fee_amount), 0)::NUMERIC AS fee,
  COALESCE(SUM(factor_cost), 0)::NUMERIC AS factor,
  COALESCE(SUM(net_amount), 0)::NUMERIC AS net
FROM settlements;

CREATE VIEW settlement_effective_view AS
SELECT
  s.id, s.load_id, s.booking_id,
  l.origin_city, l.origin_state, l.dest_city, l.dest_state, l.equipment_type,
  s.miles, s.rate_per_mile,
  s.gross_amount, s.fee_amount, s.fee_pct_applied, s.factor_cost,
  s.factored,
  s.net_amount AS original_net_amount,
  COALESCE(adj.total, 0) AS adjustment_total,
  s.net_amount + COALESCE(adj.total, 0) AS effective_net_amount,
  COALESCE(adj.count, 0)::INTEGER AS adjustment_count,
  COALESCE(dsp.open_count, 0)::INTEGER AS open_dispute_count,
  s.settled_at
FROM settlements s
JOIN loads l ON l.id = s.load_id
LEFT JOIN (
  SELECT settlement_id, SUM(amount) AS total, COUNT(*) AS count
  FROM settlement_adjustments GROUP BY settlement_id
) adj ON adj.settlement_id = s.id
LEFT JOIN (
  SELECT settlement_id, COUNT(*) AS open_count
  FROM settlement_disputes WHERE status IN ('open', 'under_review')
  GROUP BY settlement_id
) dsp ON dsp.settlement_id = s.id;

-- Self-scoping: see migration 0011 for why the identity filter lives here.
CREATE VIEW driver_earnings_view AS
SELECT
  d.id                                              AS driver_id,
  d.full_name,
  COUNT(s.id)::INTEGER                              AS loads_settled,
  COALESCE(SUM(s.miles), 0)                         AS miles,
  COALESCE(SUM(s.gross_amount), 0)                  AS gross,
  COALESCE(SUM(s.fee_amount), 0)                    AS platform_fees,
  COALESCE(SUM(s.factor_cost), 0)                   AS quick_pay_cost,
  COALESCE(SUM(s.net_amount), 0)                    AS net,
  COALESCE(SUM(adj.total), 0)                       AS adjustments,
  COALESCE(SUM(s.net_amount), 0) + COALESCE(SUM(adj.total), 0) AS effective_net,
  CASE WHEN COALESCE(SUM(s.miles), 0) > 0
       THEN ROUND((SUM(s.net_amount) / SUM(s.miles))::NUMERIC, 4)
       ELSE 0 END                                   AS net_per_mile,
  CASE WHEN COALESCE(SUM(s.miles), 0) > 0
       THEN ROUND((SUM(s.gross_amount) / SUM(s.miles))::NUMERIC, 4)
       ELSE 0 END                                   AS gross_per_mile,
  MIN(s.settled_at)                                 AS first_settled_at,
  MAX(s.settled_at)                                 AS last_settled_at
FROM driver_profiles d
LEFT JOIN bookings b    ON b.driver_id = d.id AND b.status = 'completed'
LEFT JOIN settlements s ON s.booking_id = b.id
LEFT JOIN (
  SELECT settlement_id, SUM(amount) AS total FROM settlement_adjustments GROUP BY settlement_id
) adj ON adj.settlement_id = s.id
WHERE app_is_admin() OR d.id = app_current_driver_id()
GROUP BY d.id, d.full_name;

GRANT SELECT ON public_ledger_view, settlement_totals_view, settlement_effective_view,
                driver_earnings_view TO asoc_app;
