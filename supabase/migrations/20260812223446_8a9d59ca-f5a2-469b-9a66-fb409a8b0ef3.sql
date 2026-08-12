ALTER TABLE public.insider_dealing_events
  ADD COLUMN IF NOT EXISTS ai_verdict text,
  ADD COLUMN IF NOT EXISTS ai_confidence numeric,
  ADD COLUMN IF NOT EXISTS ai_rationale text,
  ADD COLUMN IF NOT EXISTS ai_nudge numeric,
  ADD COLUMN IF NOT EXISTS ai_scanned_at timestamptz;

CREATE INDEX IF NOT EXISTS insider_dealing_events_unscanned
  ON public.insider_dealing_events (fetched_at DESC)
  WHERE ai_scanned_at IS NULL;

CREATE TABLE IF NOT EXISTS public.insider_scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL DEFAULT 'manual',
  targets integer NOT NULL DEFAULT 0,
  detected integer NOT NULL DEFAULT 0,
  stored integer NOT NULL DEFAULT 0,
  ai_scored integer NOT NULL DEFAULT 0,
  signals integer NOT NULL DEFAULT 0,
  mechanical integer NOT NULL DEFAULT 0,
  noise integer NOT NULL DEFAULT 0,
  alerted integer NOT NULL DEFAULT 0,
  model text,
  duration_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.insider_scan_runs TO authenticated;
GRANT ALL ON public.insider_scan_runs TO service_role;
ALTER TABLE public.insider_scan_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read insider scan runs"
  ON public.insider_scan_runs FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS insider_scan_runs_created ON public.insider_scan_runs (created_at DESC);