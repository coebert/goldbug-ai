CREATE TABLE public.exec_post_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  executive_id TEXT NOT NULL,
  executive_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  post_date DATE NOT NULL,
  headline TEXT NOT NULL,
  source TEXT,
  url TEXT,
  sentiment NUMERIC,
  base_price NUMERIC,
  ret_1d NUMERIC,
  ret_3d NUMERIC,
  ret_5d NUMERIC,
  max_adverse_pct NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, executive_id, symbol, post_date, headline)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.exec_post_events TO authenticated;
GRANT ALL ON public.exec_post_events TO service_role;
ALTER TABLE public.exec_post_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own exec post events" ON public.exec_post_events
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.exec_post_lessons (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_days INTEGER NOT NULL DEFAULT 90,
  sample_size INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  narrative TEXT,
  lessons JSONB NOT NULL DEFAULT '[]'::jsonb,
  coefficients JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.exec_post_lessons TO authenticated;
GRANT ALL ON public.exec_post_lessons TO service_role;
ALTER TABLE public.exec_post_lessons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own exec post lessons" ON public.exec_post_lessons
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX exec_post_events_user_date_idx ON public.exec_post_events (user_id, post_date DESC);
CREATE INDEX exec_post_lessons_user_active_idx ON public.exec_post_lessons (user_id, active, generated_at DESC);

CREATE TRIGGER update_exec_post_events_updated_at BEFORE UPDATE ON public.exec_post_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER update_exec_post_lessons_updated_at BEFORE UPDATE ON public.exec_post_lessons
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();