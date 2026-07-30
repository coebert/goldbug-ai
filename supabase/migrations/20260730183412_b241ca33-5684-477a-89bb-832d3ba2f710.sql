REVOKE ALL ON FUNCTION public.consume_rate_limit(text, double precision, double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text, double precision, double precision, double precision) TO service_role;

COMMENT ON FUNCTION public.consume_rate_limit(text, double precision, double precision, double precision) IS
  'Internal token-bucket rate limiter. SECURITY DEFINER and service_role only: signed-in users must never call it directly (they could drain or refill buckets and bypass abuse limits). Do not grant EXECUTE to anon/authenticated.';

COMMENT ON TABLE public.rate_limit_buckets IS
  'Internal rate-limit state. RLS on with no client-facing policies on purpose: reachable only via service_role through public.consume_rate_limit. Never add authenticated policies.';