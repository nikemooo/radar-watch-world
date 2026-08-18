ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS direct_links_verified integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS direct_links_unverified integer NOT NULL DEFAULT 0;