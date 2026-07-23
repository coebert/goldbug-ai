CREATE TABLE public.saxo_oauth_tokens (
  env text PRIMARY KEY CHECK (env IN ('sim','live')),
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  token_type text NOT NULL DEFAULT 'Bearer',
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.saxo_oauth_tokens TO service_role;
ALTER TABLE public.saxo_oauth_tokens ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (via supabaseAdmin) can access.