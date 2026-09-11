ALTER TABLE public.trading_controls
  ADD COLUMN IF NOT EXISTS cash_sleeve_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cash_sleeve_symbol text NOT NULL DEFAULT 'ERNS.L',
  ADD COLUMN IF NOT EXISTS cash_sleeve_buffer numeric NOT NULL DEFAULT 1500;