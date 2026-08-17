
ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS primary_url text,
  ADD COLUMN IF NOT EXISTS discovery_url text,
  ADD COLUMN IF NOT EXISTS secondary_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS detail_status text NOT NULL DEFAULT 'not_attempted',
  ADD COLUMN IF NOT EXISTS detail_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS availability text;

ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS candidates_discovered integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidates_selected integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_fetches_ok integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_fetches_failed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extractions_ok integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extractions_failed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_cost_estimate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attributes_extracted integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attributes_missing integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS items_merged integer NOT NULL DEFAULT 0;

ALTER TABLE public.radars
  ADD COLUMN IF NOT EXISTS max_detail_fetches integer NOT NULL DEFAULT 8;

CREATE TABLE IF NOT EXISTS public.finding_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES public.radars(id) ON DELETE CASCADE,
  finding_id uuid REFERENCES public.findings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  run_id uuid,
  fingerprint text NOT NULL,
  attribute text NOT NULL,
  previous_value text,
  new_value text,
  previous_raw text,
  new_raw text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finding_changes_radar_idx ON public.finding_changes(radar_id, changed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.finding_changes TO authenticated;
GRANT ALL ON public.finding_changes TO service_role;

ALTER TABLE public.finding_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own finding changes" ON public.finding_changes;
CREATE POLICY "Users manage their own finding changes"
  ON public.finding_changes FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
