CREATE TABLE public.research_sources (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  radar_id UUID NOT NULL REFERENCES public.radars(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES public.monitor_runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'exa',
  query TEXT,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT,
  published_at TIMESTAMPTZ,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snippet TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX research_sources_radar_idx ON public.research_sources (radar_id, retrieved_at DESC);
CREATE UNIQUE INDEX research_sources_radar_url_run_idx ON public.research_sources (radar_id, url, retrieved_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_sources TO authenticated;
GRANT ALL ON public.research_sources TO service_role;

ALTER TABLE public.research_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own research sources"
ON public.research_sources FOR ALL TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS search_requests INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS search_successes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS search_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sources_retrieved INTEGER NOT NULL DEFAULT 0;