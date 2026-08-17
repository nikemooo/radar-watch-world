
-- ROLES
CREATE TYPE public.app_role AS ENUM ('admin','user');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- PROFILES
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text,
  display_name text,
  timezone text NOT NULL DEFAULT 'Europe/Stockholm',
  notification_email boolean NOT NULL DEFAULT true,
  digest_hour int NOT NULL DEFAULT 8,
  plan_key text NOT NULL DEFAULT 'free',
  onboarding_done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE TRIGGER profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email,'@',1)))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user') ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- PLANS (configurable, public)
CREATE TABLE public.plans (
  key text PRIMARY KEY,
  name text NOT NULL,
  price_amount int NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'SEK',
  interval text NOT NULL DEFAULT 'month',
  max_radars int NOT NULL DEFAULT 1,
  min_check_interval_minutes int NOT NULL DEFAULT 1440,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  stripe_price_id text,
  sort_order int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.plans TO anon, authenticated;
GRANT ALL ON public.plans TO service_role;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plans public read" ON public.plans FOR SELECT USING (active);

INSERT INTO public.plans (key,name,price_amount,currency,interval,max_radars,min_check_interval_minutes,features,sort_order) VALUES
('free','Free',0,'SEK','month',1,1440,'["1 active Radar","Daily monitoring","Daily intelligence report"]'::jsonb,1),
('pro','Pro',299,'SEK','month',10,240,'["10 active Radars","Frequent monitoring","Smart alerts","Daily intelligence","Weekly intelligence"]'::jsonb,2),
('pro_plus','Pro+',599,'SEK','month',50,60,'["50 active Radars","High-frequency monitoring","Deep research","Advanced alerts","Priority processing"]'::jsonb,3);

-- SUBSCRIPTIONS
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_key text NOT NULL REFERENCES public.plans(key),
  status text NOT NULL DEFAULT 'inactive',
  provider text NOT NULL DEFAULT 'stripe',
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
GRANT SELECT ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own subscription read" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE TRIGGER subs_updated BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RADARS
CREATE TABLE public.radars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  raw_request text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  frequency text NOT NULL DEFAULT 'smart',
  status text NOT NULL DEFAULT 'active',
  last_run_at timestamptz,
  next_run_at timestamptz,
  memory jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.radars TO authenticated;
GRANT ALL ON public.radars TO service_role;
ALTER TABLE public.radars ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own radars" ON public.radars FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER radars_updated BEFORE UPDATE ON public.radars FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX radars_user_idx ON public.radars(user_id);

-- FINDINGS (persistent monitoring state / seen entities)
CREATE TABLE public.findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES public.radars(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  fingerprint text NOT NULL,
  title text NOT NULL,
  url text,
  entity text,
  numeric_value numeric,
  currency text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (radar_id, fingerprint)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.findings TO authenticated;
GRANT ALL ON public.findings TO service_role;
ALTER TABLE public.findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own findings" ON public.findings FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ALERTS
CREATE TABLE public.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid REFERENCES public.radars(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  why_it_matters text,
  what_changed text,
  potential_impact text,
  importance text NOT NULL DEFAULT 'interesting',
  confidence numeric NOT NULL DEFAULT 0.5,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_type text,
  status text NOT NULL DEFAULT 'new',
  opened_at timestamptz,
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alerts TO authenticated;
GRANT ALL ON public.alerts TO service_role;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own alerts" ON public.alerts FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX alerts_user_created_idx ON public.alerts(user_id, created_at DESC);

-- REPORTS
CREATE TABLE public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'daily',
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.reports TO authenticated;
GRANT ALL ON public.reports TO service_role;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own reports" ON public.reports FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- MONITOR RUNS
CREATE TABLE public.monitor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES public.radars(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ok',
  provider text,
  items_found int NOT NULL DEFAULT 0,
  new_items int NOT NULL DEFAULT 0,
  alerts_created int NOT NULL DEFAULT 0,
  error text,
  cost_estimate numeric NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON public.monitor_runs TO authenticated;
GRANT ALL ON public.monitor_runs TO service_role;
ALTER TABLE public.monitor_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own runs" ON public.monitor_runs FOR ALL TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin')) WITH CHECK (auth.uid() = user_id);

-- ANALYTICS
CREATE TABLE public.analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  event text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT, SELECT ON public.analytics_events TO authenticated;
GRANT ALL ON public.analytics_events TO service_role;
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "insert own events" ON public.analytics_events FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "read own or admin events" ON public.analytics_events FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
