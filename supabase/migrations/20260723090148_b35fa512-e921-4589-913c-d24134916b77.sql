
CREATE TABLE public.market_regimes (
  id uuid primary key default gen_random_uuid(),
  as_of date not null unique,
  regime text not null,
  confidence numeric not null default 0,
  previous_regime text,
  transitioned boolean not null default false,
  signals jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now()
);
GRANT SELECT ON public.market_regimes TO authenticated, anon;
GRANT ALL ON public.market_regimes TO service_role;
ALTER TABLE public.market_regimes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "regimes readable" ON public.market_regimes FOR SELECT TO authenticated, anon USING (true);
CREATE INDEX market_regimes_as_of_idx ON public.market_regimes(as_of DESC);
