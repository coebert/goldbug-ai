CREATE TABLE public.decision_models (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  fitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  horizon_days INTEGER NOT NULL,
  lambda NUMERIC NOT NULL,
  feature_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  coefficients JSONB NOT NULL DEFAULT '[]'::jsonb,
  bucket_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  usable BOOLEAN NOT NULL DEFAULT false,
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX decision_models_user_fitted_idx ON public.decision_models (user_id, fitted_at DESC);

GRANT SELECT ON public.decision_models TO authenticated;
GRANT ALL ON public.decision_models TO service_role;

ALTER TABLE public.decision_models ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own fitted models"
  ON public.decision_models FOR SELECT TO authenticated
  USING (auth.uid() = user_id);