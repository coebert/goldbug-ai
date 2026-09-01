CREATE TABLE public.trade_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  asset_class public.asset_class NOT NULL DEFAULT 'stock',
  instrument_ccy text NOT NULL DEFAULT 'GBP',
  quantity numeric(20,8) NOT NULL CHECK (quantity > 0),
  entry_price numeric(20,8) NOT NULL CHECK (entry_price > 0),
  entry_mode text NOT NULL DEFAULT 'limit' CHECK (entry_mode IN ('limit','breakout','market')),
  stop_loss numeric(20,8) CHECK (stop_loss IS NULL OR stop_loss > 0),
  take_profit numeric(20,8) CHECK (take_profit IS NULL OR take_profit > 0),
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'armed' CHECK (status IN ('armed','open','closed','error')),
  last_error text,
  last_evaluated_at timestamptz,
  entered_at timestamptz,
  exited_at timestamptz,
  exit_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, symbol)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_strategies TO authenticated;
GRANT ALL ON public.trade_strategies TO service_role;
ALTER TABLE public.trade_strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own trade strategies" ON public.trade_strategies
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trade_strategies_touch BEFORE UPDATE ON public.trade_strategies
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

ALTER TABLE public.portfolios
  ADD COLUMN IF NOT EXISTS holding_dd_budget_pct numeric,
  ADD COLUMN IF NOT EXISTS holding_dd_autoclose boolean NOT NULL DEFAULT false;