ALTER TABLE public.live_fills
  ADD COLUMN IF NOT EXISTS fee_commission numeric(18,6),
  ADD COLUMN IF NOT EXISTS fee_exchange numeric(18,6),
  ADD COLUMN IF NOT EXISTS fee_tax numeric(18,6),
  ADD COLUMN IF NOT EXISTS fee_other numeric(18,6),
  ADD COLUMN IF NOT EXISTS fee_source text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS fee_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS broker_trade_id text;

ALTER TABLE public.live_fills
  DROP CONSTRAINT IF EXISTS live_fills_fee_source_chk;

ALTER TABLE public.live_fills
  ADD CONSTRAINT live_fills_fee_source_chk
  CHECK (fee_source IN ('none', 'model', 'broker'));

COMMENT ON COLUMN public.live_fills.fee_source IS
  'none = no fee data yet, model = our estimate, broker = booked by the broker cost/activity report';

CREATE INDEX IF NOT EXISTS live_fills_fee_sync_idx
  ON public.live_fills (portfolio_id, filled_at DESC)
  WHERE fee_source <> 'broker';

CREATE INDEX IF NOT EXISTS live_fills_broker_trade_idx
  ON public.live_fills (broker_trade_id)
  WHERE broker_trade_id IS NOT NULL;