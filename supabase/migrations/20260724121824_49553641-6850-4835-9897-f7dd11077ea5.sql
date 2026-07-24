DELETE FROM public.holdings WHERE portfolio_id='7c825889-81a1-4c32-9087-26d3847be6b1';
DELETE FROM public.trades   WHERE portfolio_id='7c825889-81a1-4c32-9087-26d3847be6b1';
DELETE FROM public.live_orders WHERE portfolio_id='7c825889-81a1-4c32-9087-26d3847be6b1';
UPDATE public.portfolios SET current_cash=300, starting_cash=300
 WHERE id='7c825889-81a1-4c32-9087-26d3847be6b1';
DELETE FROM public.equity_snapshots WHERE portfolio_id='7c825889-81a1-4c32-9087-26d3847be6b1';
INSERT INTO public.equity_snapshots(portfolio_id, snapshot_date, cash, holdings_value, total_value)
 VALUES('7c825889-81a1-4c32-9087-26d3847be6b1', CURRENT_DATE, 300, 0, 300);