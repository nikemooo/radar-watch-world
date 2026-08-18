ALTER TABLE public.radars
  ADD COLUMN IF NOT EXISTS scan_state text NOT NULL DEFAULT 'initial_scan_pending',
  ADD COLUMN IF NOT EXISTS initial_scan_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS initial_scan_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS initial_listings_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS scan_phase text NOT NULL DEFAULT 'monitoring',
  ADD COLUMN IF NOT EXISTS matching_listings integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicates_removed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocked_pages integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monitoring_transition boolean NOT NULL DEFAULT false;

-- Existing radars keep their real state: those with a completed baseline are already monitoring.
UPDATE public.radars SET scan_state = 'MONITORING', initial_scan_completed_at = COALESCE(initial_scan_completed_at, baseline_completed_at)
WHERE baseline_completed = true AND scan_state = 'initial_scan_pending';