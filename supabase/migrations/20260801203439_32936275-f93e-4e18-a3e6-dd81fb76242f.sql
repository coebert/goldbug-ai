DROP POLICY IF EXISTS trading_controls_read_auth ON public.trading_controls;
CREATE POLICY trading_controls_read_admin ON public.trading_controls
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS credit_budget_settings_read_auth ON public.credit_budget_settings;
CREATE POLICY credit_budget_settings_read_admin ON public.credit_budget_settings
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));