CREATE TABLE IF NOT EXISTS public.broker_token_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  env TEXT NOT NULL,
  source TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.broker_token_events IS
  'Append-only log of broker (Saxo) OAuth token rotation attempts. Written by service_role only; readable by administrators. Never store raw provider bodies here - detail is redacted before insert.';

GRANT SELECT ON public.broker_token_events TO authenticated;
GRANT ALL ON public.broker_token_events TO service_role;

ALTER TABLE public.broker_token_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read broker token events"
  ON public.broker_token_events
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS broker_token_events_created_at_idx
  ON public.broker_token_events (created_at DESC);