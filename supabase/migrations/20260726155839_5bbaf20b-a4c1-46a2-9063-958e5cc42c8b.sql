ALTER TABLE public.pending_slices
  ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'twap',
  ADD COLUMN IF NOT EXISTS schedule_json jsonb,
  ADD COLUMN IF NOT EXISTS adv_notional numeric;

ALTER TABLE public.pending_slices
  DROP CONSTRAINT IF EXISTS pending_slices_strategy_check;
ALTER TABLE public.pending_slices
  ADD CONSTRAINT pending_slices_strategy_check
  CHECK (strategy IN ('twap','vwap','immediate'));