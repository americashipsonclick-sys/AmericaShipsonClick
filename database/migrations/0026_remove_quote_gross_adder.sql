-- The 7% gross adder on shipper quotes is removed. A quote is now linehaul,
-- deadhead, accessorials, demand, and express, floored at the distance minimum.
--
-- Loads already posted keep their rate, and logged rate_quotes breakdowns (JSONB)
-- keep whatever they recorded.

DELETE FROM platform_config WHERE key = 'quote_gross_pct';
