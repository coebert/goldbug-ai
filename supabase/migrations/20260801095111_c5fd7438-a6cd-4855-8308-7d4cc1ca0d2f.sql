ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours');

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx
  ON public.idempotency_keys (expires_at);

CREATE OR REPLACE FUNCTION public.purge_expired_idempotency_keys()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.idempotency_keys
  WHERE expires_at < now()
     OR (status <> 'completed' AND created_at < now() - interval '1 hour');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_idempotency_keys() FROM public;
GRANT EXECUTE ON FUNCTION public.purge_expired_idempotency_keys() TO service_role;

SELECT cron.unschedule('purge-expired-idempotency-keys')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-expired-idempotency-keys');

SELECT cron.schedule(
  'purge-expired-idempotency-keys',
  '17 * * * *',
  $$SELECT public.purge_expired_idempotency_keys();$$
);