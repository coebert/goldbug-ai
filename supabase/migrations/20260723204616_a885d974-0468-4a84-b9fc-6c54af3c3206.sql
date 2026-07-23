
-- signal_performance
CREATE TABLE public.signal_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  signal_name text NOT NULL,
  window_days integer NOT NULL DEFAULT 30,
  samples integer NOT NULL DEFAULT 0,
  hits integer NOT NULL DEFAULT 0,
  hit_rate numeric,
  avg_edge_bps numeric,
  weight_avg numeric,
  as_of date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, signal_name, window_days)
);
GRANT SELECT ON public.signal_performance TO authenticated;
GRANT ALL ON public.signal_performance TO service_role;
ALTER TABLE public.signal_performance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read signal_performance" ON public.signal_performance FOR SELECT TO authenticated USING (true);

-- pending_slices
CREATE TABLE public.pending_slices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  decision_id uuid REFERENCES public.decisions(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  total_qty numeric NOT NULL,
  remaining_qty numeric NOT NULL,
  slice_qty numeric NOT NULL,
  slice_count integer NOT NULL DEFAULT 4,
  slices_done integer NOT NULL DEFAULT 0,
  limit_price numeric,
  next_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','expired','canceled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_slices_active_idx ON public.pending_slices (portfolio_id, status, next_at);
GRANT SELECT ON public.pending_slices TO authenticated;
GRANT ALL ON public.pending_slices TO service_role;
ALTER TABLE public.pending_slices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read pending_slices" ON public.pending_slices FOR SELECT TO authenticated USING (true);

-- sector_scores
CREATE TABLE public.sector_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sector text NOT NULL,
  etf_symbol text NOT NULL,
  momentum_30d numeric,
  momentum_90d numeric,
  score numeric,
  rank integer,
  as_of date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sector, as_of)
);
GRANT SELECT ON public.sector_scores TO authenticated;
GRANT ALL ON public.sector_scores TO service_role;
ALTER TABLE public.sector_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read sector_scores" ON public.sector_scores FOR SELECT TO authenticated USING (true);

-- touch trigger for updated_at
CREATE TRIGGER tg_signal_performance_touch BEFORE UPDATE ON public.signal_performance FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER tg_pending_slices_touch BEFORE UPDATE ON public.pending_slices FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER tg_sector_scores_touch BEFORE UPDATE ON public.sector_scores FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
