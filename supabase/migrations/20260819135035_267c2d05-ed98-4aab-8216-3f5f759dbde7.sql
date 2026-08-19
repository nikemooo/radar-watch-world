ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS evidence_conflicts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS structured_prices_joined integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS visual_observations integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS identifiers_found integer NOT NULL DEFAULT 0;