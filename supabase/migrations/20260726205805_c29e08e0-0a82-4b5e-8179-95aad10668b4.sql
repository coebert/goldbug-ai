
-- 1) Drop the wrong-by-default GBP stamp on live orders and allow NULL so the
--    executor can record the true instrument currency instead.
ALTER TABLE public.live_orders ALTER COLUMN instrument_ccy DROP DEFAULT;
ALTER TABLE public.live_orders ALTER COLUMN instrument_ccy DROP NOT NULL;

-- 2) Enable multi-currency routing on the High risk sim portfolio so USD/GBP
--    buys are funded from the EUR wallet via a synthetic FX leg instead of
--    being sent naked to the broker (which rejects with InsufficientCash).
UPDATE public.portfolios
   SET fx_enabled = true
 WHERE id = 'be68327c-e2fd-43b6-a7d1-e3c6862ea1b7';

-- 3) Clear stale / stuck orders that carry the wrong GBP stamp so the next
--    hourly run rebuilds a clean order book.
UPDATE public.live_orders
   SET status = 'cancelled',
       reject_reason = COALESCE(reject_reason, '') || ' [housekeeping: cleared during instrument_ccy fix]'
 WHERE portfolio_id = 'be68327c-e2fd-43b6-a7d1-e3c6862ea1b7'
   AND status IN ('pending','submitted','error');
