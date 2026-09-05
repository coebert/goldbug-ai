CREATE TABLE public.market_signal_strength (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  market text NOT NULL,
  session text NOT NULL,
  horizon_days integer NOT NULL DEFAULT 5,
  samples integer NOT NULL DEFAULT 0,
  dates integer NOT NULL DEFAULT 0,
  hit_rate double precision,
  mean_net_bps double precision,
  ic double precision,
  t_stat double precision,
  strength double precision NOT NULL DEFAULT 0,
  from_date date,
  to_date date,
  computed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, market, session, horizon_days)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_signal_strength TO authenticated;
GRANT ALL ON public.market_signal_strength TO service_role;
ALTER TABLE public.market_signal_strength ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own market strengths"
  ON public.market_signal_strength FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);