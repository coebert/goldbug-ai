UPDATE public.live_broker_log
SET response = jsonb_set(response, '{startingCashAdjusted}', 'false'::jsonb, true)
WHERE method = 'CASH_SYNC'
  AND status = 200
  AND (response->>'startingCashAdjusted')::boolean = true
  AND (response->>'delta')::numeric < 0
  AND NOT (response ? 'previousStarting');