
ALTER TABLE public.portfolio_lessons ADD COLUMN IF NOT EXISTS user_id UUID;

UPDATE public.portfolio_lessons pl
SET user_id = p.user_id
FROM public.portfolios p
WHERE p.id = pl.portfolio_id AND pl.user_id IS NULL;

-- Drop rows that cannot be attributed (shouldn't exist, but safe).
DELETE FROM public.portfolio_lessons WHERE user_id IS NULL;

ALTER TABLE public.portfolio_lessons ALTER COLUMN user_id SET NOT NULL;

-- Preserve lessons when portfolios are deleted.
ALTER TABLE public.portfolio_lessons
  DROP CONSTRAINT IF EXISTS portfolio_lessons_portfolio_id_fkey;
ALTER TABLE public.portfolio_lessons ALTER COLUMN portfolio_id DROP NOT NULL;
ALTER TABLE public.portfolio_lessons
  ADD CONSTRAINT portfolio_lessons_portfolio_id_fkey
  FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS portfolio_lessons_user_regime_idx
  ON public.portfolio_lessons (user_id, regime, as_of DESC);

DROP POLICY IF EXISTS "Users manage their own portfolio lessons" ON public.portfolio_lessons;
CREATE POLICY "Users manage their own portfolio lessons"
ON public.portfolio_lessons FOR ALL
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
