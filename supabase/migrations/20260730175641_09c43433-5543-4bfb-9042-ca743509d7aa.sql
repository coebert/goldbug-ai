DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['run_metrics','credit_budget_alerts','ai_gateway_health_alerts'] LOOP
    FOR p IN SELECT policyname FROM pg_policies
             WHERE schemaname='public' AND tablename=t AND cmd='SELECT' LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.has_role(auth.uid(), ''admin''))',
      t || '_select_admin', t);
  END LOOP;
END $$;