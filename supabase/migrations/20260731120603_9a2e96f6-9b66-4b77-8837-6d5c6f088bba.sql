CREATE TABLE public.corporate_action_alert_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  threshold_hours integer[] NOT NULL DEFAULT '{72,24,4}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.corporate_action_alert_settings TO authenticated;
GRANT ALL ON public.corporate_action_alert_settings TO service_role;

ALTER TABLE public.corporate_action_alert_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY ca_alert_settings_own ON public.corporate_action_alert_settings
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.corporate_action_alerts_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  portfolio_id uuid,
  event_id text NOT NULL,
  threshold_hours integer NOT NULL,
  deadline timestamptz,
  hours_remaining numeric,
  suppressed boolean NOT NULL DEFAULT false,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_id, threshold_hours)
);

CREATE INDEX corporate_action_alerts_sent_user_idx
  ON public.corporate_action_alerts_sent (user_id, sent_at DESC);

GRANT SELECT ON public.corporate_action_alerts_sent TO authenticated;
GRANT ALL ON public.corporate_action_alerts_sent TO service_role;

ALTER TABLE public.corporate_action_alerts_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY ca_alerts_sent_read_own ON public.corporate_action_alerts_sent
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.corporate_action_alerts_sent IS
  'Dedupe log for corporate-action deadline countdown pushes. Writes are service_role only by design.';

SELECT cron.schedule(
  'aegis-corporate-action-deadlines',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757.lovable.app/api/public/hooks/corporate-action-deadlines',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);