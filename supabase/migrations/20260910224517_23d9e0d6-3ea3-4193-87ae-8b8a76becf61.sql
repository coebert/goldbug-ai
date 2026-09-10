ALTER TABLE public.trading_controls
  ADD COLUMN IF NOT EXISTS core_allocation_pct numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS core_symbol text NOT NULL DEFAULT 'VWRL.L',
  ADD COLUMN IF NOT EXISTS core_band_pct numeric NOT NULL DEFAULT 0.05;