CREATE TABLE IF NOT EXISTS public.alpha_model_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  model_kind text NOT NULL,
  window_days integer NOT NULL DEFAULT 30,
  samples integer NOT NULL DEFAULT 0,
  hits integer NOT NULL DEFAULT 0,
  hit_rate numeric,
  avg_edge_bps numeric,
  as_of date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, model_kind, window_days)
);

GRANT SELECT ON public.alpha_model_performance TO authenticated;
GRANT ALL ON public.alpha_model_performance TO service_role;
ALTER TABLE public.alpha_model_performance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alpha_model_performance_read_own" ON public.alpha_model_performance
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = alpha_model_performance.portfolio_id AND p.user_id = auth.uid()));

CREATE TABLE IF NOT EXISTS public.signal_weight_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  as_of date NOT NULL,
  regime text NOT NULL DEFAULT 'unknown',
  model_kind text NOT NULL,
  base_weight numeric NOT NULL,
  multiplier numeric NOT NULL,
  effective_weight numeric NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, as_of, model_kind)
);

GRANT SELECT ON public.signal_weight_history TO authenticated;
GRANT ALL ON public.signal_weight_history TO service_role;
ALTER TABLE public.signal_weight_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signal_weight_history_read_own" ON public.signal_weight_history
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = signal_weight_history.portfolio_id AND p.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_signal_weight_history_portfolio_asof
  ON public.signal_weight_history (portfolio_id, as_of DESC);