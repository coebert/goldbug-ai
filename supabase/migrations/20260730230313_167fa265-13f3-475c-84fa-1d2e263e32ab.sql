ALTER TABLE public.news_cache
  ADD COLUMN IF NOT EXISTS relevance_score numeric,
  ADD COLUMN IF NOT EXISTS relevance_reason text,
  ADD COLUMN IF NOT EXISTS relevance_tags jsonb;

CREATE INDEX IF NOT EXISTS news_cache_relevance_idx
  ON public.news_cache (news_date DESC, relevance_score DESC NULLS LAST);