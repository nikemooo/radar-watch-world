ALTER TABLE public.market_events
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS importance_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS novelty_score numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fact_confidence numeric NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS interpretation_confidence numeric NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS affected_assets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS entities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS source_quality text NOT NULL DEFAULT 'secondary',
  ADD COLUMN IF NOT EXISTS last_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_alerted_at timestamptz,
  ADD COLUMN IF NOT EXISTS alert_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS market_events_user_updated_idx
  ON public.market_events (user_id, last_updated_at DESC);