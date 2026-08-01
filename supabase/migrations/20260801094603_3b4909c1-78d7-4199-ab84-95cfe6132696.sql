-- 1. Restore the real-money baseline that a phantom "withdrawal" wiped out.
UPDATE public.portfolios
SET starting_cash = 10300
WHERE name = 'My Portfolio' AND mode = 'live_prod' AND starting_cash < 10300;

-- 2. Neutralise the bad CASH_SYNC log row so the dashboard stops treating
--    the -8999.68 baseline re-anchor as a withdrawal.
UPDATE public.live_broker_log
SET response = response
  || jsonb_build_object('startingCashAdjusted', false,
                        'newStarting', 10300,
                        'previousStarting', 10300,
                        'depositGateReason', 'repaired: internal reallocation, not a withdrawal')
WHERE method = 'CASH_SYNC'
  AND (response->>'delta')::numeric = -8999.68
  AND (response->>'startingCashAdjusted')::boolean IS TRUE;

-- 3. Repair historical snapshots written with unpriced LSE holdings
--    (holdings_value 877.21 vs a true ~8,888 mark).
UPDATE public.equity_snapshots e
SET holdings_value = 8888.80,
    total_value = cash + 8888.80,
    source = 'repair_unpriced_lse'
FROM public.portfolios p
WHERE p.id = e.portfolio_id
  AND p.name = 'My Portfolio'
  AND p.mode = 'live_prod'
  AND e.holdings_value = 877.21;