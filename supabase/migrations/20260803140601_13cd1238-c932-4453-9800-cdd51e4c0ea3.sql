-- 1. Index matching the real broker-log read pattern (portfolio + method + status, newest first)
CREATE INDEX IF NOT EXISTS live_broker_log_portfolio_method_status_created_idx
  ON public.live_broker_log (portfolio_id, method, status, created_at DESC);

CREATE INDEX IF NOT EXISTS live_broker_log_created_idx
  ON public.live_broker_log (created_at DESC);

-- 2. Retention: broker logs are diagnostics, not a ledger. Keep 30 days.
CREATE OR REPLACE FUNCTION public.prune_live_broker_log()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.live_broker_log
  WHERE created_at < now() - interval '30 days';
$$;

SELECT cron.schedule(
  'prune-live-broker-log',
  '17 4 * * *',
  $$SELECT public.prune_live_broker_log();$$
) WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-live-broker-log');

-- 3. Explicit policies for the two RLS-enabled / no-policy internal tables.
--    Both are written only by server code (service_role bypasses RLS);
--    admins get read access for diagnostics.
GRANT SELECT ON public.run_locks TO authenticated;
GRANT ALL ON public.run_locks TO service_role;

CREATE POLICY "Admins can view run locks"
  ON public.run_locks FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON public.market_open_alerts_sent TO authenticated;
GRANT ALL ON public.market_open_alerts_sent TO service_role;

CREATE POLICY "Admins can view market open alerts"
  ON public.market_open_alerts_sent FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));