CREATE TABLE public.broker_instrument_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null default 'saxo',
  symbol text not null,
  symbol_key text not null,
  reason text not null,
  detail text,
  reject_reason text,
  portfolio_id uuid references public.portfolios(id) on delete set null,
  hit_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  cleared_at timestamptz,
  created_at timestamptz not null default now()
);

CREATE UNIQUE INDEX broker_instrument_blocks_unique
  ON public.broker_instrument_blocks (user_id, broker, symbol_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.broker_instrument_blocks TO authenticated;
GRANT ALL ON public.broker_instrument_blocks TO service_role;

ALTER TABLE public.broker_instrument_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own blocks select" ON public.broker_instrument_blocks
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own blocks insert" ON public.broker_instrument_blocks
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "own blocks update" ON public.broker_instrument_blocks
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "own blocks delete" ON public.broker_instrument_blocks
  FOR DELETE TO authenticated USING (user_id = auth.uid());