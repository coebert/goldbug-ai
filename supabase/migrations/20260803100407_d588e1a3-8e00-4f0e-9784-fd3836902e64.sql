DROP POLICY IF EXISTS news_cache_read_anon ON public.news_cache;
REVOKE SELECT ON public.news_cache FROM anon;