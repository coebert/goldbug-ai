ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS conviction double precision;
ALTER TABLE public.live_orders ADD COLUMN IF NOT EXISTS conviction double precision;