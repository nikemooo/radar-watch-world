
CREATE TABLE IF NOT EXISTS public.run_checkpoints (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.monitor_runs(id) on delete cascade,
  user_id uuid not null,
  key text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, key)
);

GRANT SELECT ON public.run_checkpoints TO authenticated;
GRANT ALL ON public.run_checkpoints TO service_role;

ALTER TABLE public.run_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own run checkpoints"
  ON public.run_checkpoints FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS run_checkpoints_run_idx ON public.run_checkpoints(run_id);

ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS continuation_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS phase_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_successful_operation text,
  ADD COLUMN IF NOT EXISTS worker_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS termination_reason text;
