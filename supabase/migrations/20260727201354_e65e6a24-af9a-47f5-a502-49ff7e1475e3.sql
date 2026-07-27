CREATE TYPE public.algo_regime_tune_status AS ENUM ('pending','accepted','rolled_back','superseded');

CREATE TABLE public.algo_regime_tune_history (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluated_at TIMESTAMPTZ,
  prev_config JSONB NOT NULL,
  new_config JSONB NOT NULL,
  baseline_matched INT NOT NULL,
  baseline_monotone BOOLEAN NOT NULL,
  baseline_normal_mean NUMERIC,
  baseline_extreme_mean NUMERIC,
  post_matched INT,
  post_monotone BOOLEAN,
  post_normal_mean NUMERIC,
  post_extreme_mean NUMERIC,
  status public.algo_regime_tune_status NOT NULL DEFAULT 'pending',
  decision_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_algo_regime_tune_history_portfolio_applied ON public.algo_regime_tune_history (portfolio_id, applied_at DESC);
CREATE INDEX idx_algo_regime_tune_history_pending ON public.algo_regime_tune_history (status, applied_at) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.algo_regime_tune_history TO authenticated;
GRANT ALL ON public.algo_regime_tune_history TO service_role;

ALTER TABLE public.algo_regime_tune_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read tune history"
  ON public.algo_regime_tune_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()));

CREATE POLICY "Owners insert tune history"
  ON public.algo_regime_tune_history FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()));

CREATE POLICY "Owners update tune history"
  ON public.algo_regime_tune_history FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()));
