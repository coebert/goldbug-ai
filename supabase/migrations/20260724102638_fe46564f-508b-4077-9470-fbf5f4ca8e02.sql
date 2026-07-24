ALTER TABLE public.lesson_overrides
  ADD COLUMN IF NOT EXISTS helpful_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unhelpful_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.lesson_overrides
  ADD COLUMN IF NOT EXISTS feedback_score integer
  GENERATED ALWAYS AS (helpful_count - unhelpful_count) STORED;

CREATE INDEX IF NOT EXISTS lesson_overrides_user_score_idx
  ON public.lesson_overrides (user_id, feedback_score DESC);