CREATE TABLE public.next_best_trade_suggestions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  suggested_on DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Europe/London')::date,
  suggested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  symbol TEXT NOT NULL,
  name TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  rank INTEGER NOT NULL DEFAULT 1,
  conviction NUMERIC(6,4) NOT NULL DEFAULT 0,
  price NUMERIC(20,8) NOT NULL DEFAULT 0,
  quantity NUMERIC(20,8) NOT NULL DEFAULT 0,
  ticket_base NUMERIC(20,8) NOT NULL DEFAULT 0,
  cost_base NUMERIC(20,8) NOT NULL DEFAULT 0,
  expected_profit_base NUMERIC(20,8) NOT NULL DEFAULT 0,
  expected_move_bps NUMERIC(12,4) NOT NULL DEFAULT 0,
  round_trip_bps NUMERIC(12,4) NOT NULL DEFAULT 0,
  net_edge_bps NUMERIC(12,4) NOT NULL DEFAULT 0,
  recommended BOOLEAN NOT NULL DEFAULT false,
  blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, symbol, suggested_on)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.next_best_trade_suggestions TO authenticated;
GRANT ALL ON public.next_best_trade_suggestions TO service_role;

ALTER TABLE public.next_best_trade_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "next_best_trade_suggestions_owner" ON public.next_best_trade_suggestions FOR ALL
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = next_best_trade_suggestions.portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = next_best_trade_suggestions.portfolio_id AND p.user_id = auth.uid()));

CREATE INDEX next_best_trade_suggestions_portfolio_time
  ON public.next_best_trade_suggestions (portfolio_id, suggested_at DESC);

CREATE TRIGGER next_best_trade_suggestions_touch
  BEFORE UPDATE ON public.next_best_trade_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();