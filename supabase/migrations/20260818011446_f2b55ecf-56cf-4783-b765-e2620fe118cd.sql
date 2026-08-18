ALTER TABLE public.monitor_runs
  ADD COLUMN IF NOT EXISTS index_pages_fetched integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS index_pages_expanded integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS index_prices_joined integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ambiguous_price_joins integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unknown_prices integer NOT NULL DEFAULT 0;