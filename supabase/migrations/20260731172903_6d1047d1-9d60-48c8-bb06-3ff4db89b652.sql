CREATE TABLE public.ticker_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  label text,
  thesis text,
  buy_above numeric,
  oversold_rsi numeric NOT NULL DEFAULT 30,
  max_vol_pct numeric NOT NULL DEFAULT 30,
  drop_below numeric,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ticker_watches TO authenticated;
GRANT ALL ON public.ticker_watches TO service_role;
ALTER TABLE public.ticker_watches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their ticker watches"
  ON public.ticker_watches FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.ticker_watch_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id uuid NOT NULL REFERENCES public.ticker_watches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  trigger_code text NOT NULL,
  alert_date date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  price numeric,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watch_id, trigger_code, alert_date)
);

GRANT SELECT ON public.ticker_watch_alerts TO authenticated;
GRANT ALL ON public.ticker_watch_alerts TO service_role;
ALTER TABLE public.ticker_watch_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read their ticker watch alerts"
  ON public.ticker_watch_alerts FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_ticker_watches_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_ticker_watches_updated_at
  BEFORE UPDATE ON public.ticker_watches
  FOR EACH ROW EXECUTE FUNCTION public.touch_ticker_watches_updated_at();

INSERT INTO public.ticker_watches (user_id, symbol, label, thesis, buy_above, oversold_rsi, max_vol_pct, drop_below)
SELECT u.id, 'AAPL', 'Apple Inc.',
  'Watching the current dip. Entry only on a confirmed recovery: daily close back above the 50-day average with volatility cooling under 30%, or a genuine oversold washout (RSI < 30). Thesis invalidated on a daily close below 280.',
  309.35, 30, 30, 280
FROM auth.users u
WHERE lower(u.email) = 'coebert@gmail.com'
ON CONFLICT (user_id, symbol) DO NOTHING;