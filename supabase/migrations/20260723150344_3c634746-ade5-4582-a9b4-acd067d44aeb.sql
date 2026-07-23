
-- Ensure only service_role can touch saxo_oauth_tokens; explicitly deny anon/authenticated
REVOKE ALL ON public.saxo_oauth_tokens FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.saxo_oauth_tokens TO service_role;

-- Explicit restrictive policy so scanners see an intentional lockdown
DROP POLICY IF EXISTS "Deny all client access to saxo_oauth_tokens" ON public.saxo_oauth_tokens;
CREATE POLICY "Deny all client access to saxo_oauth_tokens"
  ON public.saxo_oauth_tokens
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);
