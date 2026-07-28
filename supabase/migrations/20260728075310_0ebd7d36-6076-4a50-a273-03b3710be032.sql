
CREATE TABLE public.market_open_alerts_sent (
  venue text NOT NULL,
  alert_date date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue, alert_date)
);

GRANT ALL ON public.market_open_alerts_sent TO service_role;

ALTER TABLE public.market_open_alerts_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.market_open_alerts_sent
  FOR ALL TO service_role USING (true) WITH CHECK (true);

SELECT cron.schedule(
  'aegis-market-open-alerts',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757.lovable.app/api/public/hooks/market-open-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
