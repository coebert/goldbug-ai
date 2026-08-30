CREATE INDEX IF NOT EXISTS live_broker_log_portfolio_method_created_idx
  ON public.live_broker_log (portfolio_id, method, created_at DESC);

CREATE INDEX IF NOT EXISTS live_broker_log_user_created_idx
  ON public.live_broker_log (user_id, created_at DESC);

DROP INDEX IF EXISTS public.live_broker_log_portfolio_idx;