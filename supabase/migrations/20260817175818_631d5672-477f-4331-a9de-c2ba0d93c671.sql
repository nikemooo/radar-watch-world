-- Radar temporal / baseline architecture

ALTER TABLE public.radars
  ADD COLUMN IF NOT EXISTS baseline_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS baseline_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS monitoring_window text NOT NULL DEFAULT 'rolling',
  ADD COLUMN IF NOT EXISTS recency_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS recency_source text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS last_successful_sweep_at timestamptz;

ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS event_date timestamptz,
  ADD COLUMN IF NOT EXISTS retrieved_at timestamptz,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'incremental',
  ADD COLUMN IF NOT EXISTS last_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_run_id uuid;

ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS run_type text NOT NULL DEFAULT 'incremental',
  ADD COLUMN IF NOT EXISTS baseline_findings integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incremental_findings integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suppressed_baseline integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suppressed_recency integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suppressed_duplicate integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suppressed_relevance integer NOT NULL DEFAULT 0;

ALTER TABLE public.research_sources
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.alert_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES public.radars(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  run_id uuid REFERENCES public.monitor_runs(id) ON DELETE SET NULL,
  fingerprint text NOT NULL,
  title text,
  url text,
  eligible boolean NOT NULL,
  decision text NOT NULL,
  reason text NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_decisions_radar_idx ON public.alert_decisions(radar_id, created_at DESC);

GRANT SELECT ON public.alert_decisions TO authenticated;
GRANT ALL ON public.alert_decisions TO service_role;
ALTER TABLE public.alert_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read their own alert decisions" ON public.alert_decisions;
CREATE POLICY "Users read their own alert decisions"
  ON public.alert_decisions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);