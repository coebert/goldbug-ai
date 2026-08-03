UPDATE public.equity_snapshots
SET holdings_value = 8888.80,
    total_value = cash + 8888.80,
    source = 'repair_unsynced_positions'
WHERE portfolio_id = '7c825889-81a1-4c32-9087-26d3847be6b1'
  AND snapshot_date = '2026-07-23'
  AND holdings_value = 0;