CREATE TABLE IF NOT EXISTS public.breakout_expectancy_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('published','rejected','failed')),
  source text NOT NULL,
  as_of date,
  cells jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_trades integer NOT NULL DEFAULT 0,
  symbols text[] NOT NULL DEFAULT '{}',
  windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons text[] NOT NULL DEFAULT '{}',
  dropped_cells text[] NOT NULL DEFAULT '{}',
  triggered_by text NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS breakout_expectancy_runs_recent_idx
  ON public.breakout_expectancy_runs (computed_at DESC);
CREATE INDEX IF NOT EXISTS breakout_expectancy_runs_published_idx
  ON public.breakout_expectancy_runs (status, computed_at DESC);

GRANT SELECT ON public.breakout_expectancy_runs TO authenticated;
GRANT ALL ON public.breakout_expectancy_runs TO service_role;

ALTER TABLE public.breakout_expectancy_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breakout_expectancy_runs_read_auth ON public.breakout_expectancy_runs;
CREATE POLICY breakout_expectancy_runs_read_auth ON public.breakout_expectancy_runs
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.breakout_expectancy_runs IS
  'History of automatic breakout expectancy recomputations. The newest row with status=published is the table the live regime gate reads. Writes are service_role only (the cron refresh); signed-in users can read for the analytics UI.';