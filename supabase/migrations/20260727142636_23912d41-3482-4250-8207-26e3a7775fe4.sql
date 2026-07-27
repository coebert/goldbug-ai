UPDATE public.equity_snapshots
SET cash = 14.98,
    holdings_value = 301.89 - 14.98,
    total_value = 301.89
WHERE portfolio_id = '7c825889-81a1-4c32-9087-26d3847be6b1'
  AND snapshot_date = CURRENT_DATE;