delete from public.subscriptions
where environment = 'sandbox'
  and status = 'canceled'
  and user_id = '038e1077-3a27-4bc6-b4b6-265cc4aa4fa4';
update public.profiles set plan_key = 'free' where id = '038e1077-3a27-4bc6-b4b6-265cc4aa4fa4';