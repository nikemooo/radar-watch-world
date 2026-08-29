ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS detail_queue_created integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_candidates_started integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_candidates_completed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_candidates_failed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_candidates_blocked integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_candidates_timeout integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_candidates_cached integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_candidates_remaining integer NOT NULL DEFAULT 0;