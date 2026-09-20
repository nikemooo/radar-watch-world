ALTER TABLE public.radars
  ADD COLUMN IF NOT EXISTS notify_impact_levels text[];

-- Existing radars keep today's behaviour (every level may notify) until the
-- user narrows it; new radars get a plan-aware default from the app.
UPDATE public.radars
SET notify_impact_levels = ARRAY['small','medium','large','extreme']
WHERE notify_impact_levels IS NULL;