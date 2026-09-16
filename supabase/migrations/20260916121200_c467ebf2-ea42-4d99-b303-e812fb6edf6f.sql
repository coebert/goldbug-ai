CREATE TABLE public.price_feed_status (
  symbol TEXT PRIMARY KEY,
  feed_symbol TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  last_ok_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.price_feed_status TO authenticated;
GRANT ALL ON public.price_feed_status TO service_role;
ALTER TABLE public.price_feed_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Signed-in users can read price feed status" ON public.price_feed_status FOR SELECT TO authenticated USING (true);