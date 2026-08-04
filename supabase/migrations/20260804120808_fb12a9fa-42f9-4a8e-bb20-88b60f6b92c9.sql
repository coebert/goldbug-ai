CREATE TABLE public.order_explanations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id text NOT NULL,
  order_key text NOT NULL,
  prompt_hash text NOT NULL,
  explanation text NOT NULL,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id, order_key, prompt_hash)
);

GRANT SELECT, INSERT ON public.order_explanations TO authenticated;
GRANT ALL ON public.order_explanations TO service_role;

ALTER TABLE public.order_explanations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read order explanations"
  ON public.order_explanations FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can cache order explanations"
  ON public.order_explanations FOR INSERT TO authenticated WITH CHECK (true);

CREATE INDEX idx_order_explanations_lookup
  ON public.order_explanations (decision_id, order_key);