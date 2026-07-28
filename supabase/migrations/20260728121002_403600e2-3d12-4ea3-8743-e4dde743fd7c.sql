
UPDATE public.portfolios
SET starting_cash = 10190.38
WHERE id = '7c825889-81a1-4c32-9087-26d3847be6b1'
  AND starting_cash = 13841.25;

UPDATE public.live_broker_log
SET response = jsonb_set(
      jsonb_set(response::jsonb, '{startingCashAdjusted}', 'false'::jsonb),
      '{depositGateReason}',
      to_jsonb('backfilled: TotalValue did not corroborate cash drift — reclassified as internal broker reallocation'::text)
    )
WHERE portfolio_id = '7c825889-81a1-4c32-9087-26d3847be6b1'
  AND method = 'CASH_SYNC'
  AND created_at >= '2026-07-28'
  AND (response->>'newStarting')::numeric IN (12240, 13841.25);
