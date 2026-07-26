UPDATE public.portfolios
SET starting_cash = current_cash
WHERE mode = 'live_sim'
  AND starting_cash > current_cash;