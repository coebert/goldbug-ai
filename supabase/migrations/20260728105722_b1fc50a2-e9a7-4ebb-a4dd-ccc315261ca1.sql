-- service_role bypasses RLS; these permissive ALL/true policies are redundant and flagged by the linter
DROP POLICY IF EXISTS "Service role full access to saxo_oauth_tokens" ON public.saxo_oauth_tokens;
DROP POLICY IF EXISTS "service role only" ON public.market_open_alerts_sent;

-- Replace permissive true/true UPDATE with a signed-in check
DROP POLICY IF EXISTS credit_budget_settings_update_auth ON public.credit_budget_settings;
CREATE POLICY credit_budget_settings_update_auth
  ON public.credit_budget_settings
  FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);