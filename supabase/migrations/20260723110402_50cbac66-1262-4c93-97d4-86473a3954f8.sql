ALTER TABLE public.portfolio_lessons ADD COLUMN IF NOT EXISTS regime text;
CREATE INDEX IF NOT EXISTS portfolio_lessons_regime_idx ON public.portfolio_lessons (portfolio_id, regime, as_of DESC);