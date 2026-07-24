CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('batch-retrain-daily') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'batch-retrain-daily'
);

SELECT cron.schedule(
  'batch-retrain-daily',
  '15 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757.lovable.app/api/public/hooks/batch-retrain',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);