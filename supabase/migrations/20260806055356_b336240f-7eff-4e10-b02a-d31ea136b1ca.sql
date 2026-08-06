UPDATE public.equity_snapshots
SET cash = 2816.41,
    holdings_value = 7361.10,
    total_value = 10177.51,
    source = 'broker_sync'
WHERE portfolio_id = '7c825889-81a1-4c32-9087-26d3847be6b1'
  AND snapshot_date = '2026-08-06'
  AND source = 'backfill';