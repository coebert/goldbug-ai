
CREATE TABLE public.order_reconcile_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.live_orders(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  broker TEXT NOT NULL DEFAULT 'saxo',
  env TEXT NOT NULL DEFAULT 'sim',
  broker_order_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT,
  order_type TEXT,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'reconciler',
  filled_quantity NUMERIC(20,8) NOT NULL DEFAULT 0,
  avg_fill_price NUMERIC(20,8),
  saxo_status TEXT,
  saxo_reason TEXT,
  saxo_filled_at TIMESTAMPTZ,
  saxo_response JSONB,
  submitted_at TIMESTAMPTZ,
  age_ms BIGINT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX order_reconcile_events_order_idx
  ON public.order_reconcile_events (order_id, occurred_at DESC);
CREATE INDEX order_reconcile_events_portfolio_idx
  ON public.order_reconcile_events (portfolio_id, occurred_at DESC);
CREATE INDEX order_reconcile_events_user_idx
  ON public.order_reconcile_events (user_id, occurred_at DESC);

GRANT SELECT ON public.order_reconcile_events TO authenticated;
GRANT ALL ON public.order_reconcile_events TO service_role;

ALTER TABLE public.order_reconcile_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "order_reconcile_events_owner_read"
  ON public.order_reconcile_events FOR SELECT
  USING (auth.uid() = user_id);
