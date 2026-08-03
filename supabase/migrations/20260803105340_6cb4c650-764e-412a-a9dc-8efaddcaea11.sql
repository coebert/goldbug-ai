CREATE TABLE public.hedge_fallback_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  decision_id UUID,
  run_date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  side TEXT NOT NULL,
  primary_symbol TEXT NOT NULL,
  chosen_symbol TEXT,
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  applied BOOLEAN NOT NULL DEFAULT false,
  target_notional NUMERIC NOT NULL DEFAULT 0,
  applied_notional NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX hedge_fallback_events_user_created_idx
  ON public.hedge_fallback_events (user_id, created_at DESC);
CREATE INDEX hedge_fallback_events_portfolio_run_idx
  ON public.hedge_fallback_events (portfolio_id, run_date DESC);

GRANT SELECT ON public.hedge_fallback_events TO authenticated;
GRANT ALL ON public.hedge_fallback_events TO service_role;

ALTER TABLE public.hedge_fallback_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own hedge fallback events"
  ON public.hedge_fallback_events
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);