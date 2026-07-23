
-- Index: covers both per-portfolio history reads and "latest snapshot per portfolio"
-- lookups used by the home dashboard.
CREATE INDEX IF NOT EXISTS equity_snapshots_portfolio_date_idx
  ON public.equity_snapshots (portfolio_id, snapshot_date DESC);

-- Helper view: latest snapshot per portfolio (materialised at query time via DISTINCT ON,
-- which now uses the index above). Home dashboard uses this to render totals without
-- pulling every historical row.
CREATE OR REPLACE VIEW public.portfolio_latest_totals
WITH (security_invoker = true) AS
SELECT DISTINCT ON (portfolio_id)
  portfolio_id,
  snapshot_date,
  cash,
  holdings_value,
  total_value
FROM public.equity_snapshots
ORDER BY portfolio_id, snapshot_date DESC;

GRANT SELECT ON public.portfolio_latest_totals TO authenticated;
GRANT SELECT ON public.portfolio_latest_totals TO service_role;
