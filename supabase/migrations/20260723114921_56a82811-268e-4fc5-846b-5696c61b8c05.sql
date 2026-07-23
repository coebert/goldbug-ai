
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  refilled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.rate_limit_buckets TO service_role;

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

-- No policies: table is service-role only. RLS on with no policies blocks anon/authenticated entirely.

CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  _key TEXT,
  _capacity DOUBLE PRECISION,
  _refill_per_sec DOUBLE PRECISION,
  _cost DOUBLE PRECISION DEFAULT 1
) RETURNS TABLE(allowed BOOLEAN, remaining DOUBLE PRECISION, retry_after DOUBLE PRECISION)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  now_ts TIMESTAMPTZ := now();
  cur_tokens DOUBLE PRECISION;
  cur_refilled TIMESTAMPTZ;
  new_tokens DOUBLE PRECISION;
  allow BOOLEAN;
  wait DOUBLE PRECISION;
BEGIN
  INSERT INTO public.rate_limit_buckets(key, tokens, refilled_at, updated_at)
  VALUES (_key, _capacity, now_ts, now_ts)
  ON CONFLICT (key) DO NOTHING;

  SELECT tokens, refilled_at INTO cur_tokens, cur_refilled
  FROM public.rate_limit_buckets WHERE key = _key FOR UPDATE;

  new_tokens := LEAST(_capacity, cur_tokens + EXTRACT(EPOCH FROM (now_ts - cur_refilled)) * _refill_per_sec);
  IF new_tokens >= _cost THEN
    new_tokens := new_tokens - _cost;
    allow := TRUE;
    wait := 0;
  ELSE
    allow := FALSE;
    wait := CASE WHEN _refill_per_sec > 0 THEN (_cost - new_tokens) / _refill_per_sec ELSE 3600 END;
  END IF;

  UPDATE public.rate_limit_buckets
  SET tokens = new_tokens, refilled_at = now_ts, updated_at = now_ts
  WHERE key = _key;

  RETURN QUERY SELECT allow, new_tokens, wait;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;
