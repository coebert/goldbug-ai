UPDATE public.portfolios
SET risk_config = COALESCE(risk_config, '{}'::jsonb) || jsonb_build_object('cash_floor_pct', 0)
WHERE id = '7c825889-81a1-4c32-9087-26d3847be6b1';