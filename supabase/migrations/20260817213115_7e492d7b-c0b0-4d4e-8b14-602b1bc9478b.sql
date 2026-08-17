
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS price_amount_yearly integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_product_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id_yearly text,
  ADD COLUMN IF NOT EXISTS max_alerts_per_month integer,
  ADD COLUMN IF NOT EXISTS history_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS detail_fetch_level text NOT NULL DEFAULT 'limited',
  ADD COLUMN IF NOT EXISTS max_detail_fetches integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS priority_processing boolean NOT NULL DEFAULT false;

UPDATE public.plans SET
  name = 'Free', price_amount = 0, price_amount_yearly = 0, max_radars = 2,
  min_check_interval_minutes = 1440, max_alerts_per_month = 5, history_days = 7,
  detail_fetch_level = 'limited', max_detail_fetches = 3, priority_processing = false,
  features = '["2 active Radars","1 sweep per day","5 alerts per month","Limited detail fetching","Basic change detection","7-day history"]'::jsonb
WHERE key = 'free';

UPDATE public.plans SET
  name = 'Pro', price_amount = 29900, price_amount_yearly = 299000, currency = 'SEK', max_radars = 10,
  min_check_interval_minutes = 360, max_alerts_per_month = NULL, history_days = 90,
  detail_fetch_level = 'standard', max_detail_fetches = 15, priority_processing = false,
  stripe_product_id = 'prod_V5jaY1wrYeo8TZ',
  stripe_price_id = 'price_1U5Y72GudYaBWL5huRJ5cCMA',
  stripe_price_id_yearly = 'price_1U5Y72GudYaBWL5htsklc5Fj',
  features = '["10 active Radars","Sweeps every 6 hours","Unlimited alerts","Full detail fetching","Market baseline / comparables","90-day history"]'::jsonb
WHERE key = 'pro';

UPDATE public.plans SET
  name = 'Pro+', price_amount = 59900, price_amount_yearly = 599000, currency = 'SEK', max_radars = 30,
  min_check_interval_minutes = 60, max_alerts_per_month = NULL, history_days = 365,
  detail_fetch_level = 'priority', max_detail_fetches = 25, priority_processing = true,
  stripe_product_id = 'prod_V5jagY3KTRmFTw',
  stripe_price_id = 'price_1U5Y73GudYaBWL5hjIgye7qZ',
  stripe_price_id_yearly = 'price_1U5Y73GudYaBWL5h0lvez4FW',
  features = '["30 active Radars","Hourly sweeps","Unlimited alerts","Priority detail fetching","Market baseline / comparables","1-year history"]'::jsonb
WHERE key = 'pro_plus';

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'sandbox',
  ADD COLUMN IF NOT EXISTS billing_interval text NOT NULL DEFAULT 'month',
  ADD COLUMN IF NOT EXISTS price_id text,
  ADD COLUMN IF NOT EXISTS pending_plan_key text,
  ADD COLUMN IF NOT EXISTS pending_effective_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_id_key
  ON public.subscriptions (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;
ALTER TABLE public.radars ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

UPDATE public.radars SET is_test = true WHERE name ILIKE '[TEST%';
UPDATE public.profiles SET is_internal = true
  WHERE id IN (SELECT DISTINCT user_id FROM public.radars WHERE is_test);

CREATE OR REPLACE FUNCTION public.alerts_this_month(_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::int FROM public.alerts
  WHERE user_id = _user_id AND created_at >= date_trunc('month', now());
$$;

REVOKE EXECUTE ON FUNCTION public.alerts_this_month(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.alerts_this_month(uuid) TO authenticated, service_role;
