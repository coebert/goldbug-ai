
ALTER TABLE public.pending_slices
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS pending_slices_idem_uidx
  ON public.pending_slices (portfolio_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.slice_fills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slice_id UUID NOT NULL REFERENCES public.pending_slices(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  filled_qty NUMERIC NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS slice_fills_slice_key_uidx
  ON public.slice_fills (slice_id, idempotency_key);

GRANT SELECT ON public.slice_fills TO authenticated;
GRANT ALL ON public.slice_fills TO service_role;

ALTER TABLE public.slice_fills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner read slice_fills" ON public.slice_fills
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.portfolios p
    WHERE p.id = slice_fills.portfolio_id AND p.user_id = auth.uid()
  ));
