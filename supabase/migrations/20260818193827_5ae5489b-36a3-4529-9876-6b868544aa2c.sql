ALTER TABLE public.radars
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'find_and_watch',
  ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS criteria_updated_at timestamptz;

ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS first_useful_result_at timestamptz,
  ADD COLUMN IF NOT EXISTS listings_removed integer NOT NULL DEFAULT 0;