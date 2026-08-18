ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS extraction_attempted integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extraction_ai_calls integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extraction_sources_used text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS attributes_verified integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS images_found integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS images_persisted integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jsonld_found integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS og_data_found integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS evidence_merge_count integer NOT NULL DEFAULT 0;