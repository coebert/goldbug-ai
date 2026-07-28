CREATE TABLE IF NOT EXISTS public.credit_budget_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  monthly_budget_credits numeric(12,2) NOT NULL DEFAULT 500 CHECK (monthly_budget_credits > 0),
  credits_per_ai_call numeric(10,4) NOT NULL DEFAULT 0.15 CHECK (credits_per_ai_call > 0),
  warn_pct_mtd numeric(5,2) NOT NULL DEFAULT 70 CHECK (warn_pct_mtd BETWEEN 1 AND 100),
  warn_pct_projection numeric(5,2) NOT NULL DEFAULT 90 CHECK (warn_pct_projection BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.credit_budget_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

GRANT SELECT, UPDATE ON public.credit_budget_settings TO authenticated;
GRANT ALL ON public.credit_budget_settings TO service_role;

ALTER TABLE public.credit_budget_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "credit_budget_settings_read_auth"
  ON public.credit_budget_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "credit_budget_settings_update_auth"
  ON public.credit_budget_settings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER credit_budget_settings_touch
  BEFORE UPDATE ON public.credit_budget_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();


CREATE TABLE IF NOT EXISTS public.credit_budget_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  alert_date date NOT NULL,
  mtd_credits numeric(12,4) NOT NULL,
  projected_month_credits numeric(12,4) NOT NULL,
  budget_credits numeric(12,2) NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, alert_date)
);

GRANT SELECT ON public.credit_budget_alerts TO authenticated;
GRANT ALL ON public.credit_budget_alerts TO service_role;

ALTER TABLE public.credit_budget_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "credit_budget_alerts_read_auth"
  ON public.credit_budget_alerts FOR SELECT TO authenticated USING (true);