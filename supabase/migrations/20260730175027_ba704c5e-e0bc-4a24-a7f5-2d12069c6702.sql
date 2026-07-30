-- 1. Trading kill switch + daily notional ceiling (singleton row).
CREATE TABLE IF NOT EXISTS public.trading_controls (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  trading_enabled boolean NOT NULL DEFAULT true,
  daily_notional_limit numeric NOT NULL DEFAULT 2000,
  base_currency text NOT NULL DEFAULT 'GBP',
  halt_reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.trading_controls TO authenticated;
GRANT UPDATE ON public.trading_controls TO authenticated;
GRANT ALL ON public.trading_controls TO service_role;

ALTER TABLE public.trading_controls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trading_controls_read_auth ON public.trading_controls;
CREATE POLICY trading_controls_read_auth ON public.trading_controls
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS trading_controls_update_admin ON public.trading_controls;
CREATE POLICY trading_controls_update_admin ON public.trading_controls
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.trading_controls (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_trading_controls_touch ON public.trading_controls;
CREATE TRIGGER trg_trading_controls_touch
  BEFORE UPDATE ON public.trading_controls
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- 2. Narrow public read for cached headlines (already-public reference data),
--    so the public news endpoint can drop its privileged client.
DROP POLICY IF EXISTS news_cache_read_anon ON public.news_cache;
CREATE POLICY news_cache_read_anon ON public.news_cache
  FOR SELECT TO anon USING (true);
GRANT SELECT ON public.news_cache TO anon;

-- 3. Document the intentionally fail-closed internal tables.
COMMENT ON TABLE public.run_locks IS
  'Internal run coordination. RLS on with NO policies on purpose: reachable only via service_role. Never add client-facing policies.';
COMMENT ON TABLE public.market_open_alerts_sent IS
  'Internal dedupe log for market-open pushes. RLS on with NO policies on purpose: service_role only.';
COMMENT ON TABLE public.credit_budget_alerts IS
  'Budget alert history. Read-only for signed-in users; writes are service_role only by design - do not add authenticated write policies.';
COMMENT ON TABLE public.trading_controls IS
  'Singleton hard safety switch checked immediately before any live broker order. Admin-only writes via has_role().';

-- 4. Scheduled jobs: replace public-key auth with the private secret, and sign
--    the money-moving jobs with a timestamped HMAC.
DO $$
DECLARE
  base text := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757.lovable.app';
BEGIN
  PERFORM cron.alter_job(15, command => format($j$
  SELECT net.http_post(
    url := '%s/api/public/hooks/backfill-daily-equity-changes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := '{"days": 30}'::jsonb
  ) AS request_id;
  $j$, base));

  PERFORM cron.alter_job(21, command => format($j$
  SELECT net.http_post(
    url := '%s/api/public/hooks/news-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := '{"max": 30}'::jsonb
  ) AS request_id;
  $j$, base));
END $$;

-- Signed variants for the endpoints that can move money.
DO $$
DECLARE
  base text := 'https://project--5594d905-189c-4619-9fe0-7e9d01f54757.lovable.app';
  j record;
BEGIN
  FOR j IN
    SELECT * FROM (VALUES
      (7,  '/api/public/hooks/hourly-run'),
      (6,  '/api/public/hooks/daily-run'),
      (5,  '/api/public/hooks/live-reconcile'),
      (22, '/api/public/hooks/live-reconcile')
    ) AS t(jobid, path)
  LOOP
    PERFORM cron.alter_job(j.jobid, command => format($j$
  WITH s AS (
    SELECT decrypted_secret AS secret,
           extract(epoch FROM now())::bigint::text AS ts
      FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1
  )
  SELECT net.http_post(
    url := '%s%s',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', s.secret,
      'x-cron-timestamp', s.ts,
      'x-cron-signature', encode(extensions.hmac(s.ts || '.' || '%s', s.secret, 'sha256'), 'hex')
    ),
    body := '{}'::jsonb
  ) AS request_id FROM s;
    $j$, base, j.path, j.path));
  END LOOP;
END $$;