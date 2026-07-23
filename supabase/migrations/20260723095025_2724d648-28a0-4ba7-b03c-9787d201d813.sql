
-- 1. Extend portfolio_mode enum
ALTER TYPE portfolio_mode ADD VALUE IF NOT EXISTS 'live_sim';
ALTER TYPE portfolio_mode ADD VALUE IF NOT EXISTS 'live_prod';

-- 2. Portfolio columns
ALTER TABLE public.portfolios
  ADD COLUMN IF NOT EXISTS broker text,
  ADD COLUMN IF NOT EXISTS broker_account_id text,
  ADD COLUMN IF NOT EXISTS live_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_activated_at timestamptz;

-- 3. live_orders
CREATE TABLE IF NOT EXISTS public.live_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  decision_id uuid REFERENCES public.decisions(id) ON DELETE SET NULL,
  broker text NOT NULL DEFAULT 'saxo',
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  quantity numeric(18,6) NOT NULL,
  order_type text NOT NULL DEFAULT 'market' CHECK (order_type IN ('market','limit')),
  limit_price numeric(18,6),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','filled','partial','cancelled','rejected','error')),
  broker_order_id text,
  reject_reason text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_orders TO authenticated;
GRANT ALL ON public.live_orders TO service_role;
ALTER TABLE public.live_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live_orders_owner" ON public.live_orders
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER live_orders_touch BEFORE UPDATE ON public.live_orders
  FOR EACH ROW EXECUTE FUNCTION tg_touch_updated_at();
CREATE INDEX IF NOT EXISTS live_orders_portfolio_idx ON public.live_orders(portfolio_id, created_at DESC);

-- 4. live_fills
CREATE TABLE IF NOT EXISTS public.live_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.live_orders(id) ON DELETE CASCADE,
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  quantity numeric(18,6) NOT NULL,
  fill_price numeric(18,6) NOT NULL,
  fee numeric(18,6) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'GBP',
  broker_fill_id text,
  filled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_fills TO authenticated;
GRANT ALL ON public.live_fills TO service_role;
ALTER TABLE public.live_fills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live_fills_owner" ON public.live_fills
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS live_fills_portfolio_idx ON public.live_fills(portfolio_id, filled_at DESC);

-- 5. live_broker_log
CREATE TABLE IF NOT EXISTS public.live_broker_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  broker text NOT NULL DEFAULT 'saxo',
  env text NOT NULL DEFAULT 'sim',
  method text NOT NULL,
  path text NOT NULL,
  status integer,
  request jsonb,
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.live_broker_log TO authenticated;
GRANT ALL ON public.live_broker_log TO service_role;
ALTER TABLE public.live_broker_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live_broker_log_owner_read" ON public.live_broker_log
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "live_broker_log_owner_insert" ON public.live_broker_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS live_broker_log_portfolio_idx ON public.live_broker_log(portfolio_id, created_at DESC);

-- 6. live_reconciliation
CREATE TABLE IF NOT EXISTS public.live_reconciliation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  as_of timestamptz NOT NULL DEFAULT now(),
  broker_cash numeric(18,2),
  broker_positions jsonb,
  local_cash numeric(18,2),
  local_positions jsonb,
  drift_flag boolean NOT NULL DEFAULT false,
  drift_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.live_reconciliation TO authenticated;
GRANT ALL ON public.live_reconciliation TO service_role;
ALTER TABLE public.live_reconciliation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live_recon_owner" ON public.live_reconciliation
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 7. saxo_instrument_cache (shared public reference data)
CREATE TABLE IF NOT EXISTS public.saxo_instrument_cache (
  symbol text NOT NULL,
  env text NOT NULL DEFAULT 'sim',
  uic bigint NOT NULL,
  asset_type text NOT NULL,
  currency text,
  exchange_id text,
  tick_size numeric(18,8),
  raw jsonb,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, env)
);
GRANT SELECT ON public.saxo_instrument_cache TO authenticated;
GRANT ALL ON public.saxo_instrument_cache TO service_role;
ALTER TABLE public.saxo_instrument_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "saxo_cache_read_auth" ON public.saxo_instrument_cache
  FOR SELECT TO authenticated USING (true);
