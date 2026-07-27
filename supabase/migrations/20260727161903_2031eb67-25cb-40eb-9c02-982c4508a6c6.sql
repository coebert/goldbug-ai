UPDATE public.portfolios
SET starting_cash = 300.00,
    updated_at = now()
WHERE id = '7c825889-81a1-4c32-9087-26d3847be6b1'
  AND starting_cash <> 300.00;