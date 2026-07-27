UPDATE public.portfolios
   SET fx_enabled = true
 WHERE id = 'd7567038-0241-42f2-83ea-95925a4073ed';

UPDATE public.live_orders
   SET status = 'cancelled',
       reject_reason = 'auto-cancelled: stale submitted order after cross-currency guard fix'
 WHERE portfolio_id = 'd7567038-0241-42f2-83ea-95925a4073ed'
   AND status = 'submitted';