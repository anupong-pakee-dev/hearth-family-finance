create or replace function hearth_fx(cur text, main text) returns numeric language sql stable as $$
  select case when cur is null or main is null or cur = main then 1::numeric else coalesce(
    (select rate from exchange_rates where base = cur and quote = main order by date desc limit 1),
    (select 1 / rate from exchange_rates where base = main and quote = cur order by date desc limit 1),
    1::numeric) end
$$;
alter table user_preferences drop column if exists fx_watch;
drop table if exists user_exchange_rates;
