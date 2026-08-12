CREATE TABLE public.order_batch_queue (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'buy',
  quantity NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  notional_base NUMERIC NOT NULL,
  conviction NUMERIC,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_batch_queue_side_chk CHECK (side = 'buy'),
  CONSTRAINT order_batch_queue_unique_symbol UNIQUE (portfolio_id, symbol)
);

CREATE INDEX order_batch_queue_portfolio_idx ON public.order_batch_queue (portfolio_id, expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_batch_queue TO authenticated;
GRANT ALL ON public.order_batch_queue TO service_role;

ALTER TABLE public.order_batch_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own batched orders"
  ON public.order_batch_queue FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);