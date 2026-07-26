
DELETE FROM public.trades t
USING public.portfolios p
WHERE t.portfolio_id = p.id
  AND p.mode IN ('live_sim', 'live_prod')
  AND NOT EXISTS (
    SELECT 1 FROM public.live_fills f
    WHERE f.portfolio_id = t.portfolio_id
      AND f.symbol = t.symbol
      AND f.side::text = t.side::text
  );

DELETE FROM public.live_orders WHERE symbol = 'TEST';

INSERT INTO public.live_broker_log (portfolio_id, user_id, broker, env, method, path, status, request, response, error)
SELECT
  p.id,
  p.user_id,
  'internal',
  'sim',
  'AUDIT_LEDGER_GAP',
  '/audit/high-risk-sim/2026-07-24',
  200,
  jsonb_build_object('note', 'Unexplained cash reset to 1,000,000 with 0 holdings on 2026-07-24. No sell trades or live_fills recorded to explain the liquidation.'),
  jsonb_build_object('action', 'ledger gap flagged for review'),
  NULL
FROM public.portfolios p
WHERE p.id = 'be68327c-e2fd-43b6-a7d1-e3c6862ea1b7';
