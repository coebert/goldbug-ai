CREATE TABLE public.insider_dealing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  company text NOT NULL,
  event_date date,
  headline text NOT NULL,
  summary text,
  source text,
  url text,
  direction text NOT NULL DEFAULT 'unknown',
  flavour text NOT NULL DEFAULT 'unknown',
  person text,
  role text,
  shares numeric,
  value numeric,
  severity numeric NOT NULL DEFAULT 0,
  sentiment_nudge numeric NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX insider_dealing_events_dedupe
  ON public.insider_dealing_events (symbol, COALESCE(event_date, '1970-01-01'::date), md5(lower(headline)));
CREATE INDEX insider_dealing_events_symbol_date
  ON public.insider_dealing_events (symbol, event_date DESC);

GRANT SELECT ON public.insider_dealing_events TO authenticated;
GRANT ALL ON public.insider_dealing_events TO service_role;

ALTER TABLE public.insider_dealing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read insider dealings"
  ON public.insider_dealing_events
  FOR SELECT
  TO authenticated
  USING (true);