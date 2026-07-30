DELETE FROM public.holdings WHERE portfolio_id = 'd7567038-0241-42f2-83ea-95925a4073ed';
DELETE FROM public.equity_snapshots WHERE portfolio_id = 'd7567038-0241-42f2-83ea-95925a4073ed';
UPDATE public.portfolios
   SET current_cash = starting_cash,
       cash_by_ccy = jsonb_build_object(currency, starting_cash)
 WHERE id = 'd7567038-0241-42f2-83ea-95925a4073ed';