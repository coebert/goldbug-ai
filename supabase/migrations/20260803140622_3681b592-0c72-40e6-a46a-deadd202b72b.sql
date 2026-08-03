REVOKE EXECUTE ON FUNCTION public.prune_live_broker_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_live_broker_log() TO postgres, service_role;