CREATE TABLE public.market_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  radar_id UUID NOT NULL REFERENCES public.radars(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  run_id UUID,
  event_key TEXT NOT NULL,
  title TEXT NOT NULL,
  fact_summary TEXT NOT NULL DEFAULT '',
  ai_analysis TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'low',
  relevance NUMERIC NOT NULL DEFAULT 0,
  confidence NUMERIC NOT NULL DEFAULT 0.5,
  categories TEXT[] NOT NULL DEFAULT '{}',
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_count INTEGER NOT NULL DEFAULT 1,
  published_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  instrument TEXT,
  metric TEXT,
  market_value NUMERIC,
  market_change_pct NUMERIC,
  correlation JSONB NOT NULL DEFAULT '{}'::jsonb,
  alerted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (radar_id, event_key)
);

CREATE INDEX market_events_radar_published_idx ON public.market_events (radar_id, published_at DESC NULLS LAST);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_events TO authenticated;
GRANT ALL ON public.market_events TO service_role;

ALTER TABLE public.market_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own market events"
ON public.market_events FOR ALL TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_market_events_updated_at
BEFORE UPDATE ON public.market_events
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();