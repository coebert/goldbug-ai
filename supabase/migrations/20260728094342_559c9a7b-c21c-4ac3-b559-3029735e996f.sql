
CREATE TABLE IF NOT EXISTS public.ai_gateway_health_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  alert_date date NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, alert_date)
);

GRANT SELECT ON public.ai_gateway_health_alerts TO authenticated;
GRANT ALL ON public.ai_gateway_health_alerts TO service_role;

ALTER TABLE public.ai_gateway_health_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated can read ai gateway health alerts"
  ON public.ai_gateway_health_alerts FOR SELECT TO authenticated USING (true);
