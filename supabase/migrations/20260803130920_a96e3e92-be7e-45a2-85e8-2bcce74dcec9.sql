ALTER TABLE public.run_locks ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN public.run_locks.expires_at IS 'Hard TTL deadline for this lock. Any row past expires_at may be evicted by any process, so a timed-out worker cannot wedge future runs.';

CREATE INDEX IF NOT EXISTS run_locks_expires_at_idx ON public.run_locks (expires_at);

CREATE OR REPLACE FUNCTION public.sweep_expired_run_locks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.run_locks
  WHERE COALESCE(expires_at, acquired_at + interval '90 seconds') < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_expired_run_locks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_expired_run_locks() TO service_role;