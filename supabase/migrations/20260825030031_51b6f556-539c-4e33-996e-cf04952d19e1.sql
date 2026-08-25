REVOKE INSERT, UPDATE, DELETE ON public.broker_account_key_audits FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.corporate_action_alerts_sent FROM anon, authenticated;
GRANT ALL ON public.broker_account_key_audits TO service_role;
GRANT ALL ON public.corporate_action_alerts_sent TO service_role;