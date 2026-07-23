ALTER TABLE public.news_cache
  ADD COLUMN IF NOT EXISTS original_headline TEXT,
  ADD COLUMN IF NOT EXISTS original_language TEXT;