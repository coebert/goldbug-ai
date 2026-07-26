ALTER TABLE public.live_orders ALTER COLUMN instrument_ccy DROP DEFAULT;
ALTER TABLE public.live_orders ALTER COLUMN instrument_ccy SET NOT NULL;
ALTER TABLE public.live_orders
  ADD CONSTRAINT live_orders_instrument_ccy_iso4217
  CHECK (instrument_ccy ~ '^[A-Z]{3}$');