CREATE TABLE IF NOT EXISTS public.run_locks (
  name text PRIMARY KEY,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  owner text
);
GRANT ALL ON public.run_locks TO service_role;
ALTER TABLE public.run_locks ENABLE ROW LEVEL SECURITY;