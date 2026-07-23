
-- Idempotency for live order routing: deterministic client_order_id per
-- (portfolio, hour, symbol, side). The unique index guarantees repeated
-- CRON executions of the hourly hook cannot place duplicate broker orders,
-- even under concurrent invocation.

ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS client_order_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS live_orders_client_order_id_key
  ON public.live_orders (client_order_id)
  WHERE client_order_id IS NOT NULL;
