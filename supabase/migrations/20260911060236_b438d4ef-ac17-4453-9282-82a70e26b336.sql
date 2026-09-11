ALTER TABLE public.trading_controls
  ADD COLUMN IF NOT EXISTS fx_auto_close_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS fx_auto_close_loss_pct numeric NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS fx_auto_close_min_notional_base numeric NOT NULL DEFAULT 250;