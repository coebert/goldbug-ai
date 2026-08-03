CREATE TABLE public.broker_block_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  portfolio_id UUID,
  broker TEXT NOT NULL DEFAULT 'saxo',
  symbol TEXT NOT NULL,
  symbol_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  reject_reason TEXT,
  error_code TEXT,
  order_id TEXT,
  side TEXT,
  quantity NUMERIC,
  recommended_action TEXT NOT NULL,
  first_block BOOLEAN NOT NULL DEFAULT false,
  hit_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, DELETE ON public.broker_block_events TO authenticated;
GRANT ALL ON public.broker_block_events TO service_role;

ALTER TABLE public.broker_block_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own broker block events"
ON public.broker_block_events FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own broker block events"
ON public.broker_block_events FOR DELETE TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX broker_block_events_user_created_idx
  ON public.broker_block_events (user_id, created_at DESC);

CREATE TRIGGER update_broker_block_events_updated_at
BEFORE UPDATE ON public.broker_block_events
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();