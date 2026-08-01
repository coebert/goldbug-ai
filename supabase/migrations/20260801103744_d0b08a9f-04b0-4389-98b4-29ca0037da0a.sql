DROP POLICY IF EXISTS "auth read signal_performance" ON public.signal_performance;
CREATE POLICY "signal_performance_read_own" ON public.signal_performance
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = signal_performance.portfolio_id AND p.user_id = auth.uid()));

DROP POLICY IF EXISTS "valuation_write_rejections_read_authenticated" ON public.valuation_write_rejections;
CREATE POLICY "valuation_write_rejections_read_own" ON public.valuation_write_rejections
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.portfolios p WHERE p.id = valuation_write_rejections.portfolio_id AND p.user_id = auth.uid()));