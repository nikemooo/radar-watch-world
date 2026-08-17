
DROP FUNCTION IF EXISTS public.alerts_this_month(uuid);

CREATE OR REPLACE FUNCTION public.alerts_this_month()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT count(*)::int FROM public.alerts
  WHERE user_id = auth.uid() AND created_at >= date_trunc('month', now());
$$;

REVOKE EXECUTE ON FUNCTION public.alerts_this_month() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.alerts_this_month() TO authenticated, service_role;
