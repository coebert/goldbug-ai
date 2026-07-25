CREATE TABLE public.wallet_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  cash_by_ccy jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_ccy text NOT NULL,
  base_total numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, snapshot_date)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wallet_snapshots TO authenticated;
GRANT ALL ON public.wallet_snapshots TO service_role;

ALTER TABLE public.wallet_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY wallet_snapshots_owner ON public.wallet_snapshots
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = wallet_snapshots.portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = wallet_snapshots.portfolio_id AND p.user_id = auth.uid()));

CREATE INDEX wallet_snapshots_portfolio_date_idx ON public.wallet_snapshots (portfolio_id, snapshot_date DESC);