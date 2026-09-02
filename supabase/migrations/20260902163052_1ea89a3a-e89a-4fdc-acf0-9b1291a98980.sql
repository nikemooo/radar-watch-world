ALTER TABLE public.market_events
  ADD COLUMN IF NOT EXISTS what_to_watch text,
  ADD COLUMN IF NOT EXISTS market_reactions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source_identities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS independent_sources integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS market_events_importance_idx
  ON public.market_events (user_id, importance_score DESC, last_updated_at DESC);