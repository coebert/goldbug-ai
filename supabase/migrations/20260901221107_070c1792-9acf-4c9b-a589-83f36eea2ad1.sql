ALTER TABLE public.portfolios
  ADD COLUMN IF NOT EXISTS concentration_cap_pct numeric,
  ADD COLUMN IF NOT EXISTS concentration_autotrim boolean NOT NULL DEFAULT false;