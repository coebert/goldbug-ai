CREATE TABLE public.algo_regime_config_overrides (
  portfolio_id UUID NOT NULL PRIMARY KEY REFERENCES public.portfolios(id) ON DELETE CASCADE,
  config JSONB NOT NULL,
  tuned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.algo_regime_config_overrides TO authenticated;
GRANT ALL ON public.algo_regime_config_overrides TO service_role;

ALTER TABLE public.algo_regime_config_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage algo-regime overrides"
  ON public.algo_regime_config_overrides
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()));

CREATE TRIGGER algo_regime_config_overrides_touch
BEFORE UPDATE ON public.algo_regime_config_overrides
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();