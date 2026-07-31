select cron.unschedule('aegis-ticker-watch') where exists (select 1 from cron.job where jobname = 'aegis-ticker-watch');

select cron.schedule(
  'aegis-ticker-watch',
  '5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757.lovable.app/api/public/hooks/ticker-watch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);