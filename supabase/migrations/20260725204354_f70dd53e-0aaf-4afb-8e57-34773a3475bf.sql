CREATE TABLE public.run_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  triggered_by text NOT NULL,
  success boolean NOT NULL,
  error text,
  duration_ms integer NOT NULL,
  portfolios_total integer NOT NULL DEFAULT 0,
  portfolios_ok integer NOT NULL DEFAULT 0,
  portfolios_error integer NOT NULL DEFAULT 0,
  budget_exceeded_count integer NOT NULL DEFAULT 0,
  saxo_calls_total integer NOT NULL DEFAULT 0,
  saxo_calls_ok integer NOT NULL DEFAULT 0,
  saxo_calls_error integer NOT NULL DEFAULT 0,
  saxo_retries_429 integer NOT NULL DEFAULT 0,
  news_headlines integer NOT NULL DEFAULT 0,
  prices_refreshed integer NOT NULL DEFAULT 0,
  price_errors integer NOT NULL DEFAULT 0
);
CREATE INDEX run_metrics_created_at_idx ON public.run_metrics (created_at DESC);
GRANT SELECT ON public.run_metrics TO authenticated;
GRANT ALL ON public.run_metrics TO service_role;
ALTER TABLE public.run_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated can read run_metrics"
  ON public.run_metrics FOR SELECT
  TO authenticated
  USING (true);