CREATE TABLE public.price_intraday (
  symbol text NOT NULL,
  bucket_hour timestamptz NOT NULL,
  price numeric NOT NULL,
  source text NOT NULL DEFAULT 'broker',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, bucket_hour)
);

GRANT SELECT ON public.price_intraday TO authenticated;
GRANT ALL ON public.price_intraday TO service_role;

ALTER TABLE public.price_intraday ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read intraday prices"
ON public.price_intraday FOR SELECT TO authenticated USING (true);

CREATE INDEX price_intraday_bucket_idx ON public.price_intraday (bucket_hour DESC);