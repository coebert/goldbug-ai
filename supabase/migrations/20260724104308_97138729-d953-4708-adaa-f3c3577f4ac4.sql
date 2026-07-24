CREATE TABLE public.sim_fund_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  balance_after NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sim_fund_events_portfolio_idx ON public.sim_fund_events(portfolio_id, created_at DESC);

GRANT SELECT, INSERT ON public.sim_fund_events TO authenticated;
GRANT ALL ON public.sim_fund_events TO service_role;

ALTER TABLE public.sim_fund_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own sim fund events"
  ON public.sim_fund_events FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own sim fund events"
  ON public.sim_fund_events FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);
