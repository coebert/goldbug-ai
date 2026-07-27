UPDATE public.live_broker_log
SET response = jsonb_set(response, '{startingCashAdjusted}', 'false'::jsonb, true)
WHERE method = 'CASH_SYNC'
  AND status = 200
  AND (response->>'startingCashAdjusted')::boolean = true
  AND (response->>'delta')::numeric < 0
  AND (
    -- If newStarting/previousStarting are present and equal, definitely bad.
    (response ? 'newStarting' AND response ? 'previousStarting'
       AND (response->>'newStarting')::numeric = (response->>'previousStarting')::numeric)
    OR
    -- Legacy rows without newStarting/previousStarting: any negative delta
    -- flagged as adjusted is suspect because starting_cash is monotonic.
    NOT (response ? 'newStarting')
  );