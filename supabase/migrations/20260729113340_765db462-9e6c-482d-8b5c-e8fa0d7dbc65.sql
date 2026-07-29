DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aegis-live-reconcile-15min') THEN
    PERFORM cron.unschedule('aegis-live-reconcile-15min');
  END IF;
END $$;

SELECT cron.schedule(
  'aegis-live-reconcile-15min',
  '*/15 * * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757.lovable.app/api/public/hooks/live-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $CRON$
);