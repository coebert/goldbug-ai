CREATE TABLE public.risk_halt_overrides (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text,
  halt_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX idx_risk_halt_overrides_active ON public.risk_halt_overrides (portfolio_id, expires_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.risk_halt_overrides TO authenticated;
GRANT ALL ON public.risk_halt_overrides TO service_role;

ALTER TABLE public.risk_halt_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "risk_halt_overrides_own" ON public.risk_halt_overrides
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);