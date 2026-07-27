CREATE TABLE public.ai_decision_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid REFERENCES public.decisions(id) ON DELETE SET NULL,
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  run_date date NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  symbol text NOT NULL,
  asset_class text,
  action text NOT NULL CHECK (action IN ('buy','sell','hold')),
  source text NOT NULL DEFAULT 'ai_decision',
  model text,
  requested_quantity numeric(18,6),
  price numeric(18,6),
  notional numeric(18,2),
  instrument_ccy text,
  rationale text,
  market_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_id uuid REFERENCES public.live_orders(id) ON DELETE SET NULL,
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','placed','filled','partial','rejected','cancelled','skipped','hold','error')),
  outcome_detail text,
  outcome_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_decision_audit_portfolio_time_idx
  ON public.ai_decision_audit(portfolio_id, decided_at DESC);
CREATE INDEX ai_decision_audit_portfolio_run_idx
  ON public.ai_decision_audit(portfolio_id, run_date DESC);
CREATE INDEX ai_decision_audit_order_idx
  ON public.ai_decision_audit(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX ai_decision_audit_decision_idx
  ON public.ai_decision_audit(decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX ai_decision_audit_symbol_idx
  ON public.ai_decision_audit(portfolio_id, symbol, decided_at DESC);

GRANT SELECT ON public.ai_decision_audit TO authenticated;
GRANT ALL ON public.ai_decision_audit TO service_role;

ALTER TABLE public.ai_decision_audit ENABLE ROW LEVEL SECURITY;

-- Read-only for the owning user; all writes are service_role from the engine.
CREATE POLICY "ai_decision_audit_owner_read"
  ON public.ai_decision_audit
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.portfolios p
      WHERE p.id = ai_decision_audit.portfolio_id
        AND p.user_id = auth.uid()
    )
  );

CREATE TRIGGER ai_decision_audit_touch
  BEFORE UPDATE ON public.ai_decision_audit
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Propagate broker order status changes back onto the audit row.
CREATE OR REPLACE FUNCTION public.tg_sync_ai_audit_from_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.reject_reason IS DISTINCT FROM OLD.reject_reason THEN
    UPDATE public.ai_decision_audit
       SET outcome = CASE lower(NEW.status)
                       WHEN 'filled'            THEN 'filled'
                       WHEN 'partial'           THEN 'partial'
                       WHEN 'partially_filled'  THEN 'partial'
                       WHEN 'rejected'          THEN 'rejected'
                       WHEN 'cancelled'         THEN 'cancelled'
                       WHEN 'canceled'          THEN 'cancelled'
                       WHEN 'error'             THEN 'error'
                       WHEN 'pending'           THEN 'placed'
                       WHEN 'working'           THEN 'placed'
                       WHEN 'submitted'         THEN 'placed'
                       WHEN 'accepted'          THEN 'placed'
                       ELSE outcome
                     END,
           outcome_detail = COALESCE(NEW.reject_reason, ai_decision_audit.outcome_detail),
           outcome_at = now()
     WHERE order_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER live_orders_sync_ai_audit
  AFTER UPDATE ON public.live_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_sync_ai_audit_from_order();