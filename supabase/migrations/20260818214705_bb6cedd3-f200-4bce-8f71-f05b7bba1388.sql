ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_phase text NOT NULL DEFAULT 'initializing',
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;

ALTER TABLE public.radars
  ADD COLUMN IF NOT EXISTS active_run_id uuid;

CREATE INDEX IF NOT EXISTS monitor_runs_running_idx
  ON public.monitor_runs (status, heartbeat_at)
  WHERE status = 'running';