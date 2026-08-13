ALTER TABLE public.macro_lessons
  ADD COLUMN IF NOT EXISTS event_lessons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS event_reel jsonb;