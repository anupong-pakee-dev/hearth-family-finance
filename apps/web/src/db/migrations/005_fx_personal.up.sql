-- Exchange rates for everyone (Tools › Exchange rates).
-- Personal rates: the rate a person actually got (bank, exchange booth). Strictly private.
create table user_exchange_rates (
  owner_id uuid not null references users(id) on delete cascade,
  base char(3) not null,
  quote char(3) not null,
  date date not null,
  rate numeric(20,10) not null check (rate > 0),
  primary key (owner_id, base, quote, date)
);
alter table user_exchange_rates enable row level security;
alter table user_exchange_rates force row level security;
create policy user_exchange_rates_own on user_exchange_rates to hearth_app using (owner_id = hearth_uid()) with check (owner_id = hearth_uid());
grant select, insert, update, delete on user_exchange_rates to hearth_app;

-- Currencies a person wants to follow on the rates page (besides the ones their accounts and assets use).
alter table user_preferences add column fx_watch text[] not null default '{}';

-- Latest rate wins; on the same date the person's own rate wins over reference data.
-- (Runs as the caller, so RLS keeps other people's personal rates out of view.)
create or replace function hearth_fx(cur text, main text) returns numeric language sql stable as $$
  select case when cur is null or main is null or cur = main then 1::numeric else coalesce(
    (select r.rate from (
        select rate, date, 1 as pri from user_exchange_rates where owner_id = hearth_uid() and base = cur and quote = main
        union all select 1 / rate, date, 1 from user_exchange_rates where owner_id = hearth_uid() and base = main and quote = cur
        union all select rate, date, 0 from exchange_rates where base = cur and quote = main
        union all select 1 / rate, date, 0 from exchange_rates where base = main and quote = cur
      ) r order by r.date desc, r.pri desc limit 1),
    1::numeric) end
$$;
