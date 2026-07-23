
-- Enums
CREATE TYPE public.risk_level AS ENUM ('conservative', 'balanced', 'aggressive');
CREATE TYPE public.portfolio_mode AS ENUM ('backtest', 'paper');
CREATE TYPE public.portfolio_status AS ENUM ('active', 'paused', 'complete');
CREATE TYPE public.asset_class AS ENUM ('stock', 'etf', 'crypto', 'commodity', 'fx');
CREATE TYPE public.trade_side AS ENUM ('buy', 'sell');

-- Portfolios
CREATE TABLE public.portfolios (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL DEFAULT 'My Portfolio',
  starting_cash NUMERIC(14,2) NOT NULL DEFAULT 1000,
  current_cash NUMERIC(14,2) NOT NULL DEFAULT 1000,
  currency TEXT NOT NULL DEFAULT 'GBP',
  risk_level public.risk_level NOT NULL DEFAULT 'balanced',
  universe JSONB NOT NULL DEFAULT '["stock","etf","crypto","commodity","fx"]'::jsonb,
  mode public.portfolio_mode NOT NULL DEFAULT 'backtest',
  status public.portfolio_status NOT NULL DEFAULT 'active',
  last_run_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolios TO authenticated;
GRANT ALL ON public.portfolios TO service_role;
ALTER TABLE public.portfolios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolios_owner" ON public.portfolios FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Holdings
CREATE TABLE public.holdings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset_class public.asset_class NOT NULL,
  quantity NUMERIC(20,8) NOT NULL DEFAULT 0,
  avg_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, symbol)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.holdings TO authenticated;
GRANT ALL ON public.holdings TO service_role;
ALTER TABLE public.holdings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "holdings_owner" ON public.holdings FOR ALL
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = holdings.portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = holdings.portfolio_id AND p.user_id = auth.uid()));

-- Trades
CREATE TABLE public.trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset_class public.asset_class NOT NULL,
  side public.trade_side NOT NULL,
  quantity NUMERIC(20,8) NOT NULL,
  price NUMERIC(14,4) NOT NULL,
  value NUMERIC(14,2) NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trade_date DATE NOT NULL,
  reason TEXT
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trades TO authenticated;
GRANT ALL ON public.trades TO service_role;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trades_owner" ON public.trades FOR ALL
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = trades.portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = trades.portfolio_id AND p.user_id = auth.uid()));
CREATE INDEX trades_portfolio_date_idx ON public.trades(portfolio_id, trade_date DESC);

-- Decisions (daily AI briefings)
CREATE TABLE public.decisions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  run_date DATE NOT NULL,
  briefing TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  model TEXT,
  portfolio_value NUMERIC(14,2),
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.decisions TO authenticated;
GRANT ALL ON public.decisions TO service_role;
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "decisions_owner" ON public.decisions FOR ALL
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = decisions.portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = decisions.portfolio_id AND p.user_id = auth.uid()));
CREATE INDEX decisions_portfolio_date_idx ON public.decisions(portfolio_id, run_date DESC);

-- Equity snapshots for the equity curve
CREATE TABLE public.equity_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  cash NUMERIC(14,2) NOT NULL,
  holdings_value NUMERIC(14,2) NOT NULL,
  total_value NUMERIC(14,2) NOT NULL,
  UNIQUE (portfolio_id, snapshot_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.equity_snapshots TO authenticated;
GRANT ALL ON public.equity_snapshots TO service_role;
ALTER TABLE public.equity_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "equity_owner" ON public.equity_snapshots FOR ALL
  USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = equity_snapshots.portfolio_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = equity_snapshots.portfolio_id AND p.user_id = auth.uid()));

-- Price cache (shared across users; safe public read)
CREATE TABLE public.price_cache (
  symbol TEXT NOT NULL,
  price_date DATE NOT NULL,
  open NUMERIC(18,6),
  high NUMERIC(18,6),
  low NUMERIC(18,6),
  close NUMERIC(18,6) NOT NULL,
  volume NUMERIC(20,2),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, price_date)
);
GRANT SELECT ON public.price_cache TO authenticated;
GRANT ALL ON public.price_cache TO service_role;
ALTER TABLE public.price_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "price_cache_read" ON public.price_cache FOR SELECT TO authenticated USING (true);

-- News cache
CREATE TABLE public.news_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  news_date DATE NOT NULL,
  source TEXT,
  headline TEXT NOT NULL,
  url TEXT,
  summary TEXT,
  sentiment TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.news_cache TO authenticated;
GRANT ALL ON public.news_cache TO service_role;
ALTER TABLE public.news_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "news_cache_read" ON public.news_cache FOR SELECT TO authenticated USING (true);
CREATE INDEX news_cache_date_idx ON public.news_cache(news_date DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER portfolios_touch BEFORE UPDATE ON public.portfolios
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER holdings_touch BEFORE UPDATE ON public.holdings
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
