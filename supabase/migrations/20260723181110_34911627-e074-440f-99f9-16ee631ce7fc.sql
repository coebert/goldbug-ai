-- Explicit deny policies for direct client access to rate_limit_buckets.
-- All legitimate access goes through SECURITY DEFINER function public.consume_rate_limit.
REVOKE ALL ON public.rate_limit_buckets FROM anon, authenticated;
CREATE POLICY "deny_all_select" ON public.rate_limit_buckets FOR SELECT USING (false);
CREATE POLICY "deny_all_insert" ON public.rate_limit_buckets FOR INSERT WITH CHECK (false);
CREATE POLICY "deny_all_update" ON public.rate_limit_buckets FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_delete" ON public.rate_limit_buckets FOR DELETE USING (false);