select cron.alter_job(
  21,
  command := $cmd$
  SELECT net.http_post(
    url := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757.lovable.app/api/public/hooks/news-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := '{"max": 30}'::jsonb,
    timeout_milliseconds := 90000
  ) AS request_id;
  $cmd$
);