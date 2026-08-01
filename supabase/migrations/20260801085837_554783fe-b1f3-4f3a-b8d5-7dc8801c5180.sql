CREATE TABLE public.macro_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  years_covered numeric NOT NULL DEFAULT 0,
  episodes integer NOT NULL DEFAULT 0,
  news_window_days integer NOT NULL DEFAULT 365,
  model text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  narrative text NOT NULL DEFAULT '',
  lessons jsonb NOT NULL DEFAULT '[]'::jsonb,
  playbook jsonb NOT NULL DEFAULT '[]'::jsonb,
  drawdown_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.macro_lessons TO authenticated;
GRANT ALL ON public.macro_lessons TO service_role;

ALTER TABLE public.macro_lessons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own macro lessons"
  ON public.macro_lessons FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX macro_lessons_active_idx ON public.macro_lessons (user_id, active, generated_at DESC);