WITH s AS (
  SELECT decrypted_secret AS secret,
         extract(epoch FROM now())::bigint::text AS ts
    FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1
)
SELECT net.http_post(
  url := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757-dev.lovable.app/api/public/hooks/ai-gateway-health',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', s.secret,
    'x-cron-timestamp', s.ts,
    'x-cron-signature', encode(extensions.hmac(s.ts || '.' || '/api/public/hooks/ai-gateway-health', s.secret, 'sha256'), 'hex')
  ),
  body := '{}'::jsonb
) AS request_id FROM s;