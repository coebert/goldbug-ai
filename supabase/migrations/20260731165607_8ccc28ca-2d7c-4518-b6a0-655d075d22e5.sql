-- 1. has_role: SECURITY DEFINER -> SECURITY INVOKER.
-- Only ever called with auth.uid(), and user_roles has a "Users read own roles"
-- policy, so the caller can resolve their own roles without elevated rights.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

REVOKE ALL ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, service_role;

-- 2. user_roles: remove anon reach, keep read-own for signed-in users.
REVOKE ALL ON public.user_roles FROM anon;
REVOKE ALL ON public.user_roles FROM authenticated;
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

-- 3. credit_budget_settings: shared read config, admin-only update, no anon.
REVOKE ALL ON public.credit_budget_settings FROM anon;
REVOKE ALL ON public.credit_budget_settings FROM authenticated;
GRANT SELECT, UPDATE ON public.credit_budget_settings TO authenticated;
GRANT ALL ON public.credit_budget_settings TO service_role;

-- 4. order_reconcile_events: owner read only, writes are service_role only.
REVOKE ALL ON public.order_reconcile_events FROM anon;
REVOKE ALL ON public.order_reconcile_events FROM authenticated;
GRANT SELECT ON public.order_reconcile_events TO authenticated;
GRANT ALL ON public.order_reconcile_events TO service_role;

DROP POLICY IF EXISTS order_reconcile_events_owner_read ON public.order_reconcile_events;
CREATE POLICY order_reconcile_events_owner_read
  ON public.order_reconcile_events FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 5. corporate_action_alerts_sent: owner read only, writes are service_role only.
REVOKE ALL ON public.corporate_action_alerts_sent FROM anon;
REVOKE ALL ON public.corporate_action_alerts_sent FROM authenticated;
GRANT SELECT ON public.corporate_action_alerts_sent TO authenticated;
GRANT ALL ON public.corporate_action_alerts_sent TO service_role;