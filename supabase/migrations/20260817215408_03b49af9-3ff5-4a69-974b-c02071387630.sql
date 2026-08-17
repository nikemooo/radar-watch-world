create table if not exists public.markets (
  code text primary key,
  name text not null,
  currency text not null,
  locale text not null default 'en-US',
  country_codes text[] not null default '{}',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

grant select on public.markets to anon, authenticated;
grant all on public.markets to service_role;
alter table public.markets enable row level security;
create policy "Markets are public" on public.markets for select using (true);

create table if not exists public.plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references public.plans(key) on delete cascade,
  market_code text not null references public.markets(code) on delete cascade,
  billing_interval text not null check (billing_interval in ('month','year')),
  currency text not null,
  amount_minor integer not null,
  stripe_price_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (plan_key, market_code, billing_interval)
);

grant select on public.plan_prices to anon, authenticated;
grant all on public.plan_prices to service_role;
alter table public.plan_prices enable row level security;
create policy "Plan prices are public" on public.plan_prices for select using (true);

alter table public.profiles add column if not exists market_code text references public.markets(code);
alter table public.subscriptions add column if not exists market_code text;
alter table public.subscriptions add column if not exists currency text;

insert into public.markets (code, name, currency, locale, country_codes, sort_order) values
  ('se','Sweden','SEK','sv-SE', array['SE'], 1),
  ('us','United States','USD','en-US', array['US'], 2),
  ('eu','Eurozone','EUR','de-DE', array['AT','BE','HR','CY','EE','FI','FR','DE','GR','IE','IT','LV','LT','LU','MT','NL','PT','SK','SI','ES'], 3),
  ('gb','United Kingdom','GBP','en-GB', array['GB'], 4),
  ('ca','Canada','CAD','en-CA', array['CA'], 5),
  ('au','Australia','AUD','en-AU', array['AU'], 6)
on conflict (code) do nothing;

insert into public.plan_prices (plan_key, market_code, billing_interval, currency, amount_minor, stripe_price_id) values
  ('pro','se','month','SEK',29900,'price_1U5Y72GudYaBWL5huRJ5cCMA'),
  ('pro','se','year','SEK',299000,'price_1U5Y72GudYaBWL5htsklc5Fj'),
  ('pro_plus','se','month','SEK',59900,'price_1U5Y73GudYaBWL5hjIgye7qZ'),
  ('pro_plus','se','year','SEK',599000,'price_1U5Y73GudYaBWL5h0lvez4FW'),
  ('pro','us','month','USD',2999,'price_1U5YT7GudYaBWL5hMbeFJi7i'),
  ('pro','us','year','USD',29900,'price_1U5YT8GudYaBWL5hKYRHGyN2'),
  ('pro_plus','us','month','USD',5999,'price_1U5YTBGudYaBWL5hX5Vkp1kp'),
  ('pro_plus','us','year','USD',59900,'price_1U5YTBGudYaBWL5h305FNyXZ'),
  ('pro','eu','month','EUR',2999,'price_1U5YT8GudYaBWL5hoX4bNfIm'),
  ('pro','eu','year','EUR',29900,'price_1U5YT8GudYaBWL5hPFANgIwM'),
  ('pro_plus','eu','month','EUR',5999,'price_1U5YTCGudYaBWL5hX3YGKOJg'),
  ('pro_plus','eu','year','EUR',59900,'price_1U5YTCGudYaBWL5hzzfLGqS5'),
  ('pro','gb','month','GBP',2499,'price_1U5YT9GudYaBWL5hpaUkK1y4'),
  ('pro','gb','year','GBP',24990,'price_1U5YT9GudYaBWL5h3illtZF1'),
  ('pro_plus','gb','month','GBP',4999,'price_1U5YTCGudYaBWL5h8zl0Bybx'),
  ('pro_plus','gb','year','GBP',49990,'price_1U5YTDGudYaBWL5hP061p2sY'),
  ('pro','ca','month','CAD',3999,'price_1U5YT9GudYaBWL5hqy9Im6CU'),
  ('pro','ca','year','CAD',39990,'price_1U5YTAGudYaBWL5hhvIx1eqj'),
  ('pro_plus','ca','month','CAD',7999,'price_1U5YTDGudYaBWL5hv3sz3MQs'),
  ('pro_plus','ca','year','CAD',79990,'price_1U5YTDGudYaBWL5hKpP4ILLt'),
  ('pro','au','month','AUD',4999,'price_1U5YTAGudYaBWL5hip2HRigz'),
  ('pro','au','year','AUD',49990,'price_1U5YTAGudYaBWL5hjkloEmYU'),
  ('pro_plus','au','month','AUD',9999,'price_1U5YTEGudYaBWL5hOunKacTM'),
  ('pro_plus','au','year','AUD',99990,'price_1U5YTEGudYaBWL5h65mtXLLD')
on conflict (plan_key, market_code, billing_interval) do update
  set currency = excluded.currency,
      amount_minor = excluded.amount_minor,
      stripe_price_id = excluded.stripe_price_id,
      active = true;