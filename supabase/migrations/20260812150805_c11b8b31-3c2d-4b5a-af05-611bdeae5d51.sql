CREATE TABLE public.setup_scan_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual',
  scanned integer NOT NULL DEFAULT 0,
  matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  near_misses jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms integer NOT NULL DEFAULT 0,
  rate_limited boolean NOT NULL DEFAULT false
);

CREATE INDEX setup_scan_runs_ran_at_idx ON public.setup_scan_runs (ran_at DESC);

GRANT SELECT ON public.setup_scan_runs TO authenticated;
GRANT ALL ON public.setup_scan_runs TO service_role;

ALTER TABLE public.setup_scan_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can read scan runs"
  ON public.setup_scan_runs FOR SELECT TO authenticated USING (true);