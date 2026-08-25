ALTER TABLE public.live_fills DROP CONSTRAINT IF EXISTS live_fills_fee_sync_status_check;
ALTER TABLE public.live_fills
  ADD CONSTRAINT live_fills_fee_sync_status_check
  CHECK (fee_sync_status IN ('invoiced', 'pending', 'unmatched', 'unsupported', 'unit_mismatch'));