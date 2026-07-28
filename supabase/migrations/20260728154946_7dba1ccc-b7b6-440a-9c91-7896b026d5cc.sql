UPDATE public.portfolios
SET risk_config = jsonb_set(
  risk_config,
  '{asset_class_limits,stock}',
  to_jsonb(0.85::numeric)
)
WHERE id IN (
  '7c825889-81a1-4c32-9087-26d3847be6b1', -- My Portfolio (live_prod)
  'd7567038-0241-42f2-83ea-95925a4073ed'  -- Balanced risk sim
);