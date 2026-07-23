
CREATE TABLE IF NOT EXISTS public.security_alert_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  event_type TEXT NOT NULL DEFAULT 'pending_slices',
  threshold INTEGER NOT NULL DEFAULT 5,
  window_minutes INTEGER NOT NULL DEFAULT 60,
  cooldown_minutes INTEGER NOT NULL DEFAULT 30,
  last_notified_at TIMESTAMPTZ,
  last_notified_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT security_alert_settings_threshold_range CHECK (threshold BETWEEN 1 AND 10000),
  CONSTRAINT security_alert_settings_window_range CHECK (window_minutes BETWEEN 1 AND 10080),
  CONSTRAINT security_alert_settings_cooldown_range CHECK (cooldown_minutes BETWEEN 0 AND 10080)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.security_alert_settings TO authenticated;
GRANT ALL ON public.security_alert_settings TO service_role;

ALTER TABLE public.security_alert_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner manages security alert settings"
  ON public.security_alert_settings
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER security_alert_settings_touch_updated_at
  BEFORE UPDATE ON public.security_alert_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
