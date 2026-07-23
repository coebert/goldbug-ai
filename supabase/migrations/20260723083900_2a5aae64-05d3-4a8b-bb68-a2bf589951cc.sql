ALTER TABLE public.portfolios
  ADD COLUMN IF NOT EXISTS risk_config jsonb NOT NULL DEFAULT '{
    "asset_class_limits": {"stock": 0.6, "etf": 0.8, "crypto": 0.2, "commodity": 0.3, "fx": 0.3},
    "per_symbol_limit_pct": null,
    "stop_loss_pct": 0.10,
    "take_profit_pct": 0.25,
    "volatility_sizing": true,
    "vol_target_pct": 0.015
  }'::jsonb;