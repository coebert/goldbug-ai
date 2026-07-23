CREATE TABLE public.headline_translation_cache (
  source_headline TEXT PRIMARY KEY,
  language TEXT,
  translation TEXT,
  confidence NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')
);

GRANT SELECT ON public.headline_translation_cache TO authenticated;
GRANT ALL ON public.headline_translation_cache TO service_role;

ALTER TABLE public.headline_translation_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read translation cache"
  ON public.headline_translation_cache FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX headline_translation_cache_expires_at_idx
  ON public.headline_translation_cache (expires_at);

CREATE TRIGGER headline_translation_cache_touch_updated_at
  BEFORE UPDATE ON public.headline_translation_cache
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();