CREATE TABLE IF NOT EXISTS public.earnings_cache (
  symbol text PRIMARY KEY,
  next_earnings_date date,
  confidence text NOT NULL DEFAULT 'estimated',
  source text NOT NULL DEFAULT 'unknown',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days')
);

GRANT SELECT ON public.earnings_cache TO authenticated;
GRANT ALL ON public.earnings_cache TO service_role;

ALTER TABLE public.earnings_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "earnings_cache readable by authenticated" ON public.earnings_cache;
CREATE POLICY "earnings_cache readable by authenticated"
  ON public.earnings_cache
  FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS earnings_cache_next_idx
  ON public.earnings_cache(next_earnings_date);