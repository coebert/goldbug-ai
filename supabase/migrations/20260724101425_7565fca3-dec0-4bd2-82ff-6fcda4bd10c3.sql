CREATE TABLE public.retrain_settings (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  cadence_days INTEGER NOT NULL DEFAULT 7 CHECK (cadence_days BETWEEN 1 AND 365),
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  last_run_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.retrain_settings TO authenticated;
GRANT ALL ON public.retrain_settings TO service_role;

ALTER TABLE public.retrain_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own retrain settings"
  ON public.retrain_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER retrain_settings_touch_updated_at
  BEFORE UPDATE ON public.retrain_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();