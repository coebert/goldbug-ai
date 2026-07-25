-- Phase A: currency foundations
-- The portfolios table already has `currency` (base currency) and
-- `current_cash` (base-currency wallet balance). We add a per-currency
-- wallet, an FX opt-in flag, and instrument-currency on every trading row.

ALTER TABLE public.portfolios
  ADD COLUMN IF NOT EXISTS cash_by_ccy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS fx_enabled boolean NOT NULL DEFAULT false;

-- Seed cash_by_ccy from the scalar wallet so current portfolios keep their balance.
UPDATE public.portfolios
SET cash_by_ccy = jsonb_build_object(COALESCE(currency, 'GBP'), COALESCE(current_cash, 0))
WHERE cash_by_ccy = '{}'::jsonb;

ALTER TABLE public.holdings         ADD COLUMN IF NOT EXISTS instrument_ccy text NOT NULL DEFAULT 'GBP';
ALTER TABLE public.live_orders      ADD COLUMN IF NOT EXISTS instrument_ccy text NOT NULL DEFAULT 'GBP';
ALTER TABLE public.pending_slices   ADD COLUMN IF NOT EXISTS instrument_ccy text NOT NULL DEFAULT 'GBP';
ALTER TABLE public.trades           ADD COLUMN IF NOT EXISTS instrument_ccy text NOT NULL DEFAULT 'GBP';
ALTER TABLE public.decisions        ADD COLUMN IF NOT EXISTS instrument_ccy text NOT NULL DEFAULT 'GBP';

CREATE INDEX IF NOT EXISTS holdings_ccy_idx       ON public.holdings       (portfolio_id, instrument_ccy);
CREATE INDEX IF NOT EXISTS live_orders_ccy_idx    ON public.live_orders    (portfolio_id, instrument_ccy);
CREATE INDEX IF NOT EXISTS pending_slices_ccy_idx ON public.pending_slices (portfolio_id, instrument_ccy);
