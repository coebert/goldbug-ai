DROP POLICY IF EXISTS "regimes readable" ON public.market_regimes;
CREATE POLICY "regimes readable" ON public.market_regimes FOR SELECT TO authenticated USING (true);
REVOKE SELECT ON public.market_regimes FROM anon;