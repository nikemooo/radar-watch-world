CREATE TABLE public.market_observations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  radar_id uuid NOT NULL REFERENCES public.radars(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.monitor_runs(id) ON DELETE SET NULL,
  instrument text NOT NULL,
  instrument_kind text NOT NULL DEFAULT 'other',
  metric text NOT NULL,
  value numeric NOT NULL,
  unit text,
  currency text,
  base_currency text,
  quote_currency text,
  status text NOT NULL DEFAULT 'probable',
  confidence numeric NOT NULL DEFAULT 0.5,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_observations_run_instrument_unique UNIQUE (radar_id, run_id, instrument, metric)
);
GRANT SELECT, INSERT ON public.market_observations TO authenticated;
GRANT ALL ON public.market_observations TO service_role;
ALTER TABLE public.market_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read their own market observations" ON public.market_observations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can add observations to their own radars" ON public.market_observations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE INDEX market_observations_radar_history_idx ON public.market_observations (radar_id, instrument, metric, observed_at DESC);