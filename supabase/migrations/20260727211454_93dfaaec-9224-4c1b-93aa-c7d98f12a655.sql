
CREATE TABLE public.execution_calibrations (
  symbol text NOT NULL,
  asset_class text NOT NULL,
  as_of date NOT NULL,
  sample_days integer NOT NULL,
  adv_shares_20d numeric,
  adv_notional_20d numeric,
  adv_notional_60d numeric,
  realized_vol_daily numeric,
  atr_pct_14d numeric,
  spread_pct_est numeric,
  half_spread_bps_est numeric,
  vol_widening_coeff_bps_est numeric,
  impact_coeff_est numeric,
  max_impact_bps_est numeric,
  max_half_spread_bps_est numeric,
  currency text,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_calibrations_pkey PRIMARY KEY (symbol)
);

GRANT SELECT ON public.execution_calibrations TO authenticated;
GRANT ALL ON public.execution_calibrations TO service_role;

ALTER TABLE public.execution_calibrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "execution_calibrations readable by authenticated"
  ON public.execution_calibrations FOR SELECT TO authenticated USING (true);

CREATE TRIGGER trg_execution_calibrations_touch_updated_at
  BEFORE UPDATE ON public.execution_calibrations
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
