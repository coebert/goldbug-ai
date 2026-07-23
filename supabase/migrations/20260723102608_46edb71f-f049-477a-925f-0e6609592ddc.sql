
-- News sentiment enrichment
ALTER TABLE public.news_cache
  ADD COLUMN IF NOT EXISTS sentiment NUMERIC,
  ADD COLUMN IF NOT EXISTS entities JSONB,
  ADD COLUMN IF NOT EXISTS source_weight NUMERIC;

-- Macro / earnings events calendar (shared reference data)
CREATE TABLE IF NOT EXISTS public.market_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_date DATE NOT NULL,
  kind TEXT NOT NULL,             -- 'cpi' | 'fomc' | 'earnings' | 'nfp' | 'ecb' | 'boe' | 'opec' | 'other'
  symbol TEXT,                    -- nullable for macro events
  title TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT 'medium',  -- 'low' | 'medium' | 'high'
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.market_events TO authenticated;
GRANT ALL ON public.market_events TO service_role;
ALTER TABLE public.market_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "market_events_read"
  ON public.market_events FOR SELECT TO authenticated USING (true);
CREATE INDEX IF NOT EXISTS market_events_date_idx ON public.market_events(event_date);
CREATE INDEX IF NOT EXISTS market_events_symbol_idx ON public.market_events(symbol);

-- Circuit breaker + per-symbol loss cooldowns on portfolios
ALTER TABLE public.portfolios
  ADD COLUMN IF NOT EXISTS circuit_breaker JSONB NOT NULL DEFAULT '{"tripped":false}'::jsonb,
  ADD COLUMN IF NOT EXISTS loss_cooldowns JSONB NOT NULL DEFAULT '{}'::jsonb;
