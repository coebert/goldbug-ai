CREATE TABLE IF NOT EXISTS public.fundamentals_cache (
  symbol text PRIMARY KEY,
  data jsonb NOT NULL,
  currency text,
  financial_currency text,
  next_earnings_date date,
  source text NOT NULL DEFAULT 'yahoo_quote_summary',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 day')
);

GRANT SELECT ON public.fundamentals_cache TO authenticated;
GRANT ALL ON public.fundamentals_cache TO service_role;

ALTER TABLE public.fundamentals_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fundamentals_cache readable by authenticated" ON public.fundamentals_cache;
CREATE POLICY "fundamentals_cache readable by authenticated"
  ON public.fundamentals_cache
  FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS fundamentals_cache_expires_idx
  ON public.fundamentals_cache(expires_at);