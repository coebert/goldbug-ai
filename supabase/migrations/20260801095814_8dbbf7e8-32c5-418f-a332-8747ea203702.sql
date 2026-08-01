CREATE OR REPLACE FUNCTION public.purge_expired_idempotency_keys()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  -- Completed keys linger for a 24h grace period after their replay window
  -- closes so late retries get a clear "key expired" answer; only then purged.
  DELETE FROM public.idempotency_keys
  WHERE (status = 'completed' AND expires_at < now() - interval '24 hours')
     OR (status <> 'completed' AND (expires_at < now() OR created_at < now() - interval '1 hour'));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_idempotency_keys() FROM public;
REVOKE EXECUTE ON FUNCTION public.purge_expired_idempotency_keys() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_idempotency_keys() TO service_role;