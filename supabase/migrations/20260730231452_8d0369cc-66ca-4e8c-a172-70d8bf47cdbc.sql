ALTER TABLE public.headline_translation_cache
  ADD COLUMN IF NOT EXISTS norm_key TEXT;

UPDATE public.headline_translation_cache
SET norm_key = NULLIF(
  btrim(
    regexp_replace(
      regexp_replace(
        lower(source_headline),
        '^\s*(update|exclusive|breaking|analysis|refile|corrected|wrapup|factbox)\s*\d*\s*[-:–—]\s*',
        '',
        'i'
      ),
      '[^[:alnum:]]+',
      ' ',
      'g'
    )
  ),
  ''
)
WHERE norm_key IS NULL;

-- Collapse rows that normalise to the same key, keeping the freshest.
DELETE FROM public.headline_translation_cache a
USING public.headline_translation_cache b
WHERE a.norm_key IS NOT NULL
  AND a.norm_key = b.norm_key
  AND (a.updated_at, a.source_headline) < (b.updated_at, b.source_headline);

CREATE UNIQUE INDEX IF NOT EXISTS headline_translation_cache_norm_key_uidx
  ON public.headline_translation_cache (norm_key);