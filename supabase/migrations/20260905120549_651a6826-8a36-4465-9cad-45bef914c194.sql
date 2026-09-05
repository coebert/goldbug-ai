CREATE TABLE public.decision_playbooks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model TEXT NOT NULL,
  horizon_days INTEGER NOT NULL DEFAULT 5,
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  brief TEXT NOT NULL DEFAULT '',
  playbook JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX decision_playbooks_user_created_idx ON public.decision_playbooks (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.decision_playbooks TO authenticated;
GRANT ALL ON public.decision_playbooks TO service_role;
ALTER TABLE public.decision_playbooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own playbooks" ON public.decision_playbooks FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);