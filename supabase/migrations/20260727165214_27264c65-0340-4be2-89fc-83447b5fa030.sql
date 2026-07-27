CREATE TABLE public.daily_equity_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  change_date date NOT NULL,
  prev_date date NOT NULL,
  prev_equity numeric NOT NULL,
  equity numeric NOT NULL,
  raw_delta numeric NOT NULL,
  net_flow numeric NOT NULL DEFAULT 0,
  pnl numeric NOT NULL,
  pct numeric NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, change_date)
);

CREATE INDEX daily_equity_changes_portfolio_date_idx
  ON public.daily_equity_changes (portfolio_id, change_date DESC);

GRANT SELECT ON public.daily_equity_changes TO authenticated;
GRANT ALL ON public.daily_equity_changes TO service_role;

ALTER TABLE public.daily_equity_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read their portfolios' daily changes"
  ON public.daily_equity_changes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.portfolios p
      WHERE p.id = daily_equity_changes.portfolio_id
        AND p.user_id = auth.uid()
    )
  );