CREATE TABLE public.symbol_execution_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  symbol_key text NOT NULL,
  buy_bps double precision NOT NULL,
  sell_bps double precision NOT NULL,
  round_trip_bps double precision NOT NULL,
  fee_bps double precision,
  slippage_bps double precision,
  tickets integer NOT NULL DEFAULT 0,
  fills integer NOT NULL DEFAULT 0,
  invoiced_fills integer NOT NULL DEFAULT 0,
  measured boolean NOT NULL DEFAULT false,
  first_fill_at timestamptz,
  last_fill_at timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.symbol_execution_costs TO authenticated;
GRANT ALL ON public.symbol_execution_costs TO service_role;

ALTER TABLE public.symbol_execution_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own symbol execution costs"
  ON public.symbol_execution_costs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX symbol_execution_costs_user_idx
  ON public.symbol_execution_costs (user_id, round_trip_bps DESC);

CREATE TRIGGER symbol_execution_costs_touch
  BEFORE UPDATE ON public.symbol_execution_costs
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();