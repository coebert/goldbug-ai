-- Tranche F/G/K: hyperparam history, counterfactuals, calibration
CREATE TABLE public.hyperparam_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  tuned_at DATE NOT NULL,
  sma_fast INT NOT NULL,
  sma_slow INT NOT NULL,
  rsi_period INT NOT NULL,
  kelly_cap NUMERIC NOT NULL,
  train_score NUMERIC,
  oos_score NUMERIC,
  n_symbols INT NOT NULL DEFAULT 0,
  window_days INT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, tuned_at)
);
GRANT SELECT ON public.hyperparam_history TO authenticated;
GRANT ALL ON public.hyperparam_history TO service_role;
ALTER TABLE public.hyperparam_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads own hyperparam history"
  ON public.hyperparam_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()));

CREATE TABLE public.counterfactuals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  as_of DATE NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  hypothetical_price NUMERIC NOT NULL,
  block_reason TEXT NOT NULL,
  block_category TEXT NOT NULL,
  hypothetical_spend NUMERIC,
  conviction NUMERIC,
  forward_return_5d NUMERIC,
  evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.counterfactuals TO authenticated;
GRANT ALL ON public.counterfactuals TO service_role;
ALTER TABLE public.counterfactuals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads own counterfactuals"
  ON public.counterfactuals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()));
CREATE INDEX ix_counterfactuals_pending
  ON public.counterfactuals (portfolio_id, evaluated_at)
  WHERE evaluated_at IS NULL;

CREATE TABLE public.calibration_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  as_of DATE NOT NULL,
  brier_score NUMERIC NOT NULL,
  samples INT NOT NULL,
  hit_rate NUMERIC,
  avg_conviction NUMERIC,
  global_size_mult NUMERIC NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, as_of)
);
GRANT SELECT ON public.calibration_snapshots TO authenticated;
GRANT ALL ON public.calibration_snapshots TO service_role;
ALTER TABLE public.calibration_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads own calibration"
  ON public.calibration_snapshots FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()));