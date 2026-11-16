DROP POLICY IF EXISTS "Signed-in users can read scan runs" ON public.setup_scan_runs;
CREATE POLICY "Admins can read scan runs" ON public.setup_scan_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Authenticated users can view relevance run telemetry" ON public.news_relevance_runs;
CREATE POLICY "Admins can view relevance run telemetry" ON public.news_relevance_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "fundamentals_cache readable by authenticated" ON public.fundamentals_cache;
CREATE POLICY "fundamentals_cache readable by admins" ON public.fundamentals_cache
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "market_events_read" ON public.market_events;
CREATE POLICY "market_events_read_admin" ON public.market_events
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "regimes readable" ON public.market_regimes;
CREATE POLICY "regimes readable by admins" ON public.market_regimes
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "execution_calibrations readable by authenticated" ON public.execution_calibrations;
CREATE POLICY "execution_calibrations readable by admins" ON public.execution_calibrations
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Authenticated users can read insider scan runs" ON public.insider_scan_runs;
CREATE POLICY "Admins can read insider scan runs" ON public.insider_scan_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Authenticated users can read insider dealings" ON public.insider_dealing_events;
CREATE POLICY "Admins can read insider dealings" ON public.insider_dealing_events
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "earnings_cache readable by authenticated" ON public.earnings_cache;
CREATE POLICY "earnings_cache readable by admins" ON public.earnings_cache
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Authenticated can read translation cache" ON public.headline_translation_cache;
CREATE POLICY "Admins can read translation cache" ON public.headline_translation_cache
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "news_cache_read" ON public.news_cache;
CREATE POLICY "news_cache_read_admin" ON public.news_cache
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS breakout_expectancy_runs_read_auth ON public.breakout_expectancy_runs;
CREATE POLICY breakout_expectancy_runs_read_admin ON public.breakout_expectancy_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));