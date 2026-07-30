CREATE TABLE IF NOT EXISTS public.news_backfill_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),
  requested_days INTEGER NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  cursor_date DATE,
  days_total INTEGER NOT NULL,
  days_done INTEGER NOT NULL DEFAULT 0,
  headlines_inserted INTEGER NOT NULL DEFAULT 0,
  new_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

GRANT SELECT, INSERT, UPDATE ON public.news_backfill_jobs TO authenticated;
GRANT ALL ON public.news_backfill_jobs TO service_role;

ALTER TABLE public.news_backfill_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view their own backfill jobs"
  ON public.news_backfill_jobs FOR SELECT TO authenticated
  USING (created_by = auth.uid());

CREATE POLICY "Users start their own backfill jobs"
  ON public.news_backfill_jobs FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users update their own backfill jobs"
  ON public.news_backfill_jobs FOR UPDATE TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE INDEX IF NOT EXISTS news_backfill_jobs_status_idx
  ON public.news_backfill_jobs (status, created_at DESC);

CREATE TRIGGER news_backfill_jobs_touch_updated_at
  BEFORE UPDATE ON public.news_backfill_jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();