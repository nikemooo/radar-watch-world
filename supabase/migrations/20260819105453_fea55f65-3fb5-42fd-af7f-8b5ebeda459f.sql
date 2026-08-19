ALTER TABLE public.run_checkpoints
  ADD COLUMN IF NOT EXISTS radar_id uuid REFERENCES public.radars(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now();

GRANT SELECT, INSERT, UPDATE ON public.run_checkpoints TO authenticated;
GRANT ALL ON public.run_checkpoints TO service_role;

DROP POLICY IF EXISTS "Users can insert checkpoints for their own runs" ON public.run_checkpoints;
CREATE POLICY "Users can insert checkpoints for their own runs"
ON public.run_checkpoints FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (SELECT 1 FROM public.monitor_runs r WHERE r.id = run_id AND r.user_id = auth.uid())
);

DROP POLICY IF EXISTS "Users can update checkpoints for their own runs" ON public.run_checkpoints;
CREATE POLICY "Users can update checkpoints for their own runs"
ON public.run_checkpoints FOR UPDATE TO authenticated
USING (
  auth.uid() = user_id
  AND EXISTS (SELECT 1 FROM public.monitor_runs r WHERE r.id = run_id AND r.user_id = auth.uid())
)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (SELECT 1 FROM public.monitor_runs r WHERE r.id = run_id AND r.user_id = auth.uid())
);

DROP TRIGGER IF EXISTS run_checkpoints_updated ON public.run_checkpoints;
CREATE TRIGGER run_checkpoints_updated
BEFORE UPDATE ON public.run_checkpoints
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();