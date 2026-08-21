DROP POLICY IF EXISTS "Authenticated users can read broker account key audits" ON public.broker_account_key_audits;

CREATE POLICY "Admins read broker account key audits"
ON public.broker_account_key_audits
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR EXISTS (
    SELECT 1 FROM public.portfolios p
    WHERE p.id = broker_account_key_audits.portfolio_id
      AND p.user_id = auth.uid()
  )
);

REVOKE INSERT, UPDATE, DELETE ON public.broker_account_key_audits FROM authenticated, anon;
REVOKE ALL ON public.user_roles FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated;
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

COMMENT ON TABLE public.user_roles IS 'Role assignments. Read-own only for authenticated users; all writes are service_role only (no INSERT/UPDATE/DELETE policies or grants) to prevent privilege escalation.';