CREATE TABLE public.source_fetch_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  host text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  successes integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_failure_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, host)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.source_fetch_stats TO authenticated;
GRANT ALL ON public.source_fetch_stats TO service_role;
ALTER TABLE public.source_fetch_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own source fetch stats" ON public.source_fetch_stats FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.url_fetch_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  url text NOT NULL,
  host text NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_reason text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, url)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.url_fetch_state TO authenticated;
GRANT ALL ON public.url_fetch_state TO service_role;
ALTER TABLE public.url_fetch_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own url fetch state" ON public.url_fetch_state FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX url_fetch_state_next_attempt_idx ON public.url_fetch_state (user_id, next_attempt_at);

ALTER TABLE public.radars ADD COLUMN IF NOT EXISTS max_sweep_cost numeric NOT NULL DEFAULT 0.06;

ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS detail_fetches_attempted integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_fetches_skipped_backoff integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_fetch_budget integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usable_comparables integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comparable_coverage numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS baselines_backfilled integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_ceiling numeric NOT NULL DEFAULT 0;