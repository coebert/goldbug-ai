
CREATE TABLE public.shadow_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES public.decisions(id) ON DELETE SET NULL,
  run_date DATE NOT NULL,
  variant_name TEXT NOT NULL DEFAULT 'contrarian_v1',
  primary_summary JSONB NOT NULL,
  shadow_summary JSONB NOT NULL,
  agreement NUMERIC,
  primary_order_count INTEGER NOT NULL DEFAULT 0,
  shadow_order_count INTEGER NOT NULL DEFAULT 0,
  divergences JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shadow_decisions_portfolio_date ON public.shadow_decisions(portfolio_id, run_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_decisions TO authenticated;
GRANT ALL ON public.shadow_decisions TO service_role;

ALTER TABLE public.shadow_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read their shadow decisions"
  ON public.shadow_decisions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.portfolios p
      WHERE p.id = shadow_decisions.portfolio_id AND p.user_id = auth.uid()
    )
  );
