ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS criteria_matched integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS criteria_rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS criteria_unverified integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pagination_pages_attempted integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pagination_pages_succeeded integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pagination_pages_blocked integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pagination_pages_skipped integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS indexes_exhausted integer NOT NULL DEFAULT 0;