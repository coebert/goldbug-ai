ALTER TABLE public.equity_snapshots
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS provenance JSONB;

CREATE TABLE IF NOT EXISTS public.observed_quote_currency (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  quote_currency TEXT NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  sample_price NUMERIC,
  source TEXT
);

GRANT SELECT ON public.observed_quote_currency TO authenticated;
GRANT ALL ON public.observed_quote_currency TO service_role;

ALTER TABLE public.observed_quote_currency ENABLE ROW LEVEL SECURITY;

CREATE POLICY "observed_quote_currency_read_authenticated"
  ON public.observed_quote_currency FOR SELECT TO authenticated USING (true);

CREATE POLICY "observed_quote_currency_service_write"
  ON public.observed_quote_currency FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.valuation_write_rejections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  source TEXT,
  reason TEXT NOT NULL,
  attempted JSONB,
  violations JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS valuation_write_rejections_portfolio_idx
  ON public.valuation_write_rejections (portfolio_id, created_at DESC);

GRANT SELECT ON public.valuation_write_rejections TO authenticated;
GRANT ALL ON public.valuation_write_rejections TO service_role;

ALTER TABLE public.valuation_write_rejections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "valuation_write_rejections_read_authenticated"
  ON public.valuation_write_rejections FOR SELECT TO authenticated USING (true);

CREATE POLICY "valuation_write_rejections_service_write"
  ON public.valuation_write_rejections FOR ALL TO service_role USING (true) WITH CHECK (true);