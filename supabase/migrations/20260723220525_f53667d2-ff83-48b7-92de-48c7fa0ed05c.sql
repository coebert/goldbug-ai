CREATE TABLE public.security_audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event text NOT NULL,
  op text,
  reason text,
  portfolio_id uuid,
  slice_id uuid,
  actor_user_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.security_audit_log TO authenticated;
GRANT ALL ON public.security_audit_log TO service_role;

ALTER TABLE public.security_audit_log ENABLE ROW LEVEL SECURITY;

-- Signed-in users can read only events attributed to them. Rows with a
-- NULL actor (e.g. anonymous callers, cron paths) are intentionally hidden
-- from the client; those are reviewed via server-side admin reads.
CREATE POLICY "sec_audit_owner_read"
  ON public.security_audit_log
  FOR SELECT
  TO authenticated
  USING (actor_user_id = auth.uid());

CREATE INDEX security_audit_log_created_idx
  ON public.security_audit_log (created_at DESC);
CREATE INDEX security_audit_log_event_reason_idx
  ON public.security_audit_log (event, reason, created_at DESC);
CREATE INDEX security_audit_log_portfolio_idx
  ON public.security_audit_log (portfolio_id, created_at DESC);
CREATE INDEX security_audit_log_actor_idx
  ON public.security_audit_log (actor_user_id, created_at DESC);