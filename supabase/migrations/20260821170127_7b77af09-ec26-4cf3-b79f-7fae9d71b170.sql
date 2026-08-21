CREATE TABLE public.broker_account_key_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid REFERENCES public.portfolios(id) ON DELETE CASCADE,
  portfolio_name text,
  env text NOT NULL,
  configured_key_masked text,
  resolved_key_masked text,
  status text NOT NULL,
  mismatch boolean NOT NULL DEFAULT false,
  account_count integer NOT NULL DEFAULT 0,
  message text,
  changed boolean NOT NULL DEFAULT false,
  previous_status text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.broker_account_key_audits TO authenticated;
GRANT ALL ON public.broker_account_key_audits TO service_role;

ALTER TABLE public.broker_account_key_audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read broker account key audits"
  ON public.broker_account_key_audits FOR SELECT TO authenticated USING (true);

CREATE INDEX idx_broker_account_key_audits_recent
  ON public.broker_account_key_audits (env, portfolio_id, checked_at DESC);

CREATE TRIGGER broker_account_key_audits_touch
  BEFORE UPDATE ON public.broker_account_key_audits
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();