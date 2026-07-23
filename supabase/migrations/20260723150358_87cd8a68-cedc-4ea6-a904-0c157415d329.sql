
CREATE POLICY "Service role full access to saxo_oauth_tokens"
  ON public.saxo_oauth_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
