SELECT net.http_post(
  url := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757-dev.lovable.app/api/public/hooks/ai-gateway-health',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
  ),
  body := '{}'::jsonb
) AS request_id;