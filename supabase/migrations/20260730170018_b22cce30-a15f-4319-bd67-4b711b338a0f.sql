CREATE TABLE public.equity_intraday (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  bucket_hour timestamptz NOT NULL,
  cash numeric NOT NULL,
  holdings_value numeric NOT NULL,
  total_value numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, bucket_hour)
);

CREATE INDEX equity_intraday_portfolio_hour_idx
  ON public.equity_intraday (portfolio_id, bucket_hour DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.equity_intraday TO authenticated;
GRANT ALL ON public.equity_intraday TO service_role;

ALTER TABLE public.equity_intraday ENABLE ROW LEVEL SECURITY;

CREATE POLICY "equity_intraday_owner" ON public.equity_intraday FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = equity_intraday.portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = equity_intraday.portfolio_id AND p.user_id = auth.uid()));