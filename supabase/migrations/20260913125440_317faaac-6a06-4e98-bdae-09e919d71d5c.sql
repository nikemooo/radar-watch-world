-- New Plus tier plus launch limits that keep every paid tier margin-positive.
update public.plans set sort_order = 4 where key = 'pro_plus';
update public.plans set sort_order = 3 where key = 'pro';

insert into public.plans (
  key, name, currency, interval, price_amount, price_amount_yearly,
  max_radars, min_check_interval_minutes, max_alerts_per_month, history_days,
  detail_fetch_level, max_detail_fetches, priority_processing, features,
  stripe_product_id, stripe_price_id, stripe_price_id_yearly, sort_order, active
) values (
  'plus', 'Plus', 'SEK', 'month', 19900, 199000,
  3, 1440, null, 30,
  'standard', 10, false,
  '["3 active Radars","Sweeps once a day","Unlimited alerts","Full detail fetching","Market baseline / comparables","30-day history"]'::jsonb,
  'prod_VFiLCZ8zBPRhFv', 'price_1UFCurGudYaBWL5hBpesbO6k', 'price_1UFCurGudYaBWL5hQTF2iWlA', 2, true
);

update public.plans set
  max_radars = 5,
  min_check_interval_minutes = 720,
  features = '["5 active Radars","Sweeps every 12 hours","Unlimited alerts","Full detail fetching","Market baseline / comparables","90-day history"]'::jsonb
where key = 'pro';

update public.plans set
  max_radars = 10,
  min_check_interval_minutes = 360,
  features = '["10 active Radars","Sweeps every 6 hours","Unlimited alerts","Priority detail fetching","Market baseline / comparables","1-year history"]'::jsonb
where key = 'pro_plus';

insert into public.plan_prices (plan_key, market_code, currency, billing_interval, amount_minor, stripe_price_id, active) values
('plus','se','SEK','month',19900,'price_1UFCurGudYaBWL5hBpesbO6k',true),
('plus','se','SEK','year',199000,'price_1UFCurGudYaBWL5hQTF2iWlA',true),
('plus','us','USD','month',1999,'price_1UFCusGudYaBWL5hvoAzxg3v',true),
('plus','us','USD','year',19900,'price_1UFCusGudYaBWL5hMbghwfD7',true),
('plus','eu','EUR','month',1999,'price_1UFCusGudYaBWL5hmuxNBUnw',true),
('plus','eu','EUR','year',19900,'price_1UFCutGudYaBWL5hDXzVH7Bi',true),
('plus','gb','GBP','month',1699,'price_1UFCutGudYaBWL5hbuZ9Oie9',true),
('plus','gb','GBP','year',16990,'price_1UFCutGudYaBWL5hs3FZsQdD',true),
('plus','ca','CAD','month',2699,'price_1UFCuuGudYaBWL5h6ZiJ3GRZ',true),
('plus','ca','CAD','year',26990,'price_1UFCuuGudYaBWL5hkpU6ZVY4',true),
('plus','au','AUD','month',3299,'price_1UFCuuGudYaBWL5hWCigc55n',true),
('plus','au','AUD','year',32990,'price_1UFCuvGudYaBWL5hiC7TbGLs',true);
