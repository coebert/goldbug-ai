CREATE TABLE public.news_relevance_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  news_date DATE NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'unknown',
  items INTEGER NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0,
  batch_failures INTEGER NOT NULL DEFAULT 0,
  llm_scored INTEGER NOT NULL DEFAULT 0,
  fallback_items INTEGER NOT NULL DEFAULT 0,
  latency_ms_total INTEGER NOT NULL DEFAULT 0,
  latency_ms_p50 INTEGER NOT NULL DEFAULT 0,
  latency_ms_max INTEGER NOT NULL DEFAULT 0,
  failure_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
  fallback_reason TEXT
);

CREATE INDEX news_relevance_runs_created_at_idx ON public.news_relevance_runs (created_at DESC);

GRANT SELECT ON public.news_relevance_runs TO authenticated;
GRANT ALL ON public.news_relevance_runs TO service_role;

ALTER TABLE public.news_relevance_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view relevance run telemetry"
  ON public.news_relevance_runs FOR SELECT TO authenticated USING (true);