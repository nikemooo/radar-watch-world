ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS baseline_status text NOT NULL DEFAULT 'not_computed',
  ADD COLUMN IF NOT EXISTS baseline_confidence numeric,
  ADD COLUMN IF NOT EXISTS anomaly_score numeric,
  ADD COLUMN IF NOT EXISTS opportunity_score numeric,
  ADD COLUMN IF NOT EXISTS baseline_computed_at timestamptz;

ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS anomaly_score numeric,
  ADD COLUMN IF NOT EXISTS opportunity_score numeric;

ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS baselines_computed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS baselines_insufficient integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comparable_observations integer NOT NULL DEFAULT 0;

ALTER TABLE public.radars
  ADD COLUMN IF NOT EXISTS min_comparables integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS allow_broad_comparison boolean NOT NULL DEFAULT false;