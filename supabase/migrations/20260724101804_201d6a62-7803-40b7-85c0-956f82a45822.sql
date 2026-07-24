CREATE TABLE public.lesson_overrides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  original_text TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('disabled','edited')),
  replacement_text TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, original_text)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lesson_overrides TO authenticated;
GRANT ALL ON public.lesson_overrides TO service_role;

ALTER TABLE public.lesson_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own lesson overrides"
  ON public.lesson_overrides
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER lesson_overrides_touch_updated_at
  BEFORE UPDATE ON public.lesson_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE INDEX lesson_overrides_user_idx ON public.lesson_overrides(user_id);