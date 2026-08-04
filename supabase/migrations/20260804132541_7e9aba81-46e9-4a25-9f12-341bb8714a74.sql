DROP POLICY IF EXISTS "Authenticated users can cache order explanations" ON public.order_explanations;
DROP POLICY IF EXISTS "Authenticated users can read order explanations" ON public.order_explanations;

CREATE POLICY "Users read own order explanations"
ON public.order_explanations
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.decisions d
    JOIN public.portfolios p ON p.id = d.portfolio_id
    WHERE d.id::text = order_explanations.decision_id
      AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users cache own order explanations"
ON public.order_explanations
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.decisions d
    JOIN public.portfolios p ON p.id = d.portfolio_id
    WHERE d.id::text = order_explanations.decision_id
      AND p.user_id = auth.uid()
  )
);