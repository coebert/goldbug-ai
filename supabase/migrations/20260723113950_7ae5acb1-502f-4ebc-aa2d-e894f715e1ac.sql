
-- Per-portfolio time-ordered scans (attribution, diagnostics, circuit breaker, learning)
CREATE INDEX IF NOT EXISTS decisions_portfolio_date_idx
  ON public.decisions (portfolio_id, run_date DESC);
CREATE INDEX IF NOT EXISTS trades_portfolio_date_idx
  ON public.trades (portfolio_id, trade_date DESC);
CREATE INDEX IF NOT EXISTS holdings_portfolio_symbol_idx
  ON public.holdings (portfolio_id, symbol);
CREATE INDEX IF NOT EXISTS portfolio_lessons_portfolio_created_idx
  ON public.portfolio_lessons (portfolio_id, created_at DESC);

-- Live trading (broker sync, reconciliation)
CREATE INDEX IF NOT EXISTS live_orders_portfolio_created_idx
  ON public.live_orders (portfolio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_fills_portfolio_created_idx
  ON public.live_fills (portfolio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_reconciliation_portfolio_created_idx
  ON public.live_reconciliation (portfolio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_broker_log_portfolio_created_idx
  ON public.live_broker_log (portfolio_id, created_at DESC);

-- Reference data
CREATE INDEX IF NOT EXISTS price_cache_symbol_date_idx
  ON public.price_cache (symbol, price_date DESC);
CREATE INDEX IF NOT EXISTS news_cache_date_idx
  ON public.news_cache (news_date DESC);
CREATE INDEX IF NOT EXISTS market_regimes_as_of_idx
  ON public.market_regimes (as_of DESC);

ANALYZE public.decisions;
ANALYZE public.trades;
ANALYZE public.holdings;
ANALYZE public.portfolio_lessons;
ANALYZE public.live_orders;
ANALYZE public.live_fills;
ANALYZE public.live_reconciliation;
ANALYZE public.live_broker_log;
ANALYZE public.price_cache;
ANALYZE public.news_cache;
ANALYZE public.market_regimes;
