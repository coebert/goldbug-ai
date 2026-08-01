CREATE TABLE public.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX idempotency_keys_scope_unique
  ON public.idempotency_keys (user_id, endpoint, idempotency_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_keys TO authenticated;
GRANT ALL ON public.idempotency_keys TO service_role;

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own idempotency keys"
  ON public.idempotency_keys FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());