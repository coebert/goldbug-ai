
CREATE TABLE public.portfolio_lessons (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  as_of DATE NOT NULL,
  lessons JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  window_days INTEGER NOT NULL DEFAULT 20,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX portfolio_lessons_portfolio_id_idx ON public.portfolio_lessons(portfolio_id, as_of DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_lessons TO authenticated;
GRANT ALL ON public.portfolio_lessons TO service_role;

ALTER TABLE public.portfolio_lessons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own portfolio lessons"
ON public.portfolio_lessons FOR ALL
USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()))
WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = portfolio_id AND p.user_id = auth.uid()));
