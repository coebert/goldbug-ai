CREATE TABLE public.alert_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id uuid REFERENCES public.portfolios(id) ON DELETE CASCADE,
  category text NOT NULL,
  event text NOT NULL,
  endpoint_host text,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  http_status integer,
  error text,
  duration_ms integer,
  attempt_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.alert_webhook_deliveries TO authenticated;
GRANT ALL ON public.alert_webhook_deliveries TO service_role;

ALTER TABLE public.alert_webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own webhook deliveries"
ON public.alert_webhook_deliveries
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX idx_alert_webhook_deliveries_user_created
  ON public.alert_webhook_deliveries (user_id, created_at DESC);
CREATE INDEX idx_alert_webhook_deliveries_category
  ON public.alert_webhook_deliveries (category, created_at DESC);