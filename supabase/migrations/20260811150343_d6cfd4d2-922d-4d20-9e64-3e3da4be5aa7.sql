ALTER TABLE public.live_fills
  ADD COLUMN IF NOT EXISTS fee_sync_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS fee_sync_reason text,
  ADD COLUMN IF NOT EXISTS fee_sync_attempted_at timestamp with time zone;

ALTER TABLE public.live_fills
  DROP CONSTRAINT IF EXISTS live_fills_fee_sync_status_check;

ALTER TABLE public.live_fills
  ADD CONSTRAINT live_fills_fee_sync_status_check
  CHECK (fee_sync_status IN ('invoiced', 'pending', 'unmatched', 'unsupported'));

UPDATE public.live_fills
   SET fee_sync_status = 'invoiced'
 WHERE fee_source = 'broker' OR (fee_synced_at IS NOT NULL AND COALESCE(fee, 0) > 0);

CREATE INDEX IF NOT EXISTS live_fills_fee_sync_status_idx
  ON public.live_fills (portfolio_id, fee_sync_status, filled_at DESC);