CREATE TABLE public.symbol_risk_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  max_position_pct numeric CHECK (max_position_pct IS NULL OR (max_position_pct > 0 AND max_position_pct <= 1)),
  stop_loss_pct numeric CHECK (stop_loss_pct IS NULL OR (stop_loss_pct > 0 AND stop_loss_pct <= 1)),
  take_profit_pct numeric CHECK (take_profit_pct IS NULL OR (take_profit_pct > 0 AND take_profit_pct <= 5)),
  min_signal_strength numeric CHECK (min_signal_strength IS NULL OR (min_signal_strength >= 0 AND min_signal_strength <= 1)),
  paused boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.symbol_risk_overrides TO authenticated;
GRANT ALL ON public.symbol_risk_overrides TO service_role;

ALTER TABLE public.symbol_risk_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own symbol risk overrides"
ON public.symbol_risk_overrides FOR ALL TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER symbol_risk_overrides_touch
BEFORE UPDATE ON public.symbol_risk_overrides
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();