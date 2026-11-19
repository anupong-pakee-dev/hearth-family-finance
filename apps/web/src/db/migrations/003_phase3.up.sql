-- Phase 3/4 features: FX, split-aware reporting, pending DCA, Web Push, notification channels, passkeys, OIDC,
-- savings challenges, family lending, tax-fund limits, dependent portfolios, support access.

-- ───── FX (FR-TXN-11, FR-INV-18) — instance-wide reference data, written by admins / price plugins ─────
create table exchange_rates (
  base char(3) not null,
  quote char(3) not null,
  date date not null,
  rate numeric(20,10) not null check (rate > 0),
  source text not null default 'manual',
  primary key (base, quote, date)
);
grant select on exchange_rates to hearth_app;

create function hearth_fx(cur text, main text) returns numeric language sql stable as $$
  select case when cur is null or main is null or cur = main then 1::numeric else coalesce(
    (select rate from exchange_rates where base = cur and quote = main order by date desc limit 1),
    (select 1 / rate from exchange_rates where base = main and quote = cur order by date desc limit 1),
    1::numeric) end
$$;

-- Every report reads money through this view: one line per split (or per transaction when not split),
-- converted to the base currency with the transaction's fx_rate. security_invoker keeps RLS in force.
create view transaction_lines with (security_invoker = true) as
  select t.id as transaction_id, t.owner_id, t.household_id, t.kind, t.date, t.account_id, t.payee, t.created_by,
         coalesce(s.category_id, t.category_id) as category_id,
         coalesce(s.bucket_id, t.bucket_id) as bucket_id,
         round(coalesce(s.amount, t.amount) * coalesce(t.fx_rate, 1))::bigint as amount
    from transactions t left join transaction_splits s on s.transaction_id = t.id;
grant select on transaction_lines to hearth_app;

-- ───── Investments ─────
alter table investment_transactions add column pending boolean not null default false;   -- FR-INV-04 DCA awaiting confirmation
alter table investment_transactions add column dca_plan_id uuid references dca_plans(id) on delete set null;
alter table assets add column price_source text not null default 'manual';                 -- FR-INV-11 plugin id
alter table assets add column tax_type text check (tax_type in ('ssf','rmf','thaiesg','other'));
alter table user_preferences add column tax_limits jsonb not null default '{}';            -- FR-INV-22 configurable caps

-- ───── Savings challenges (FR-SAVE-09) ─────
alter table goals add column challenge text check (challenge in ('52_week','daily_increment'));
alter table goals add column challenge_step bigint;
alter table goals add column challenge_start date;

-- ───── Family lending (FR-FDEBT-08) ─────
alter table debts add column lender_member_id uuid references members(id) on delete set null;

-- ───── Notifications: Web Push + user-enabled channels (FR-NOTI-01/02) ─────
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create table notification_channels (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  kind text not null,
  label text not null default '',
  config_enc bytea not null,
  enabled boolean not null default true,
  last_error text,
  created_at timestamptz not null default now()
);
do $$
declare t text;
begin
  foreach t in array array['push_subscriptions','notification_channels'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I to hearth_app using (owner_id = hearth_uid()) with check (owner_id = hearth_uid())', t || '_own', t);
    execute format('grant select, insert, update, delete on %I to hearth_app', t);
  end loop;
end $$;
alter table user_preferences add column last_summary_sent date;

-- ───── Passkeys (FR-AUTH-05) and OIDC identities (FR-AUTH-04) — identity tables, auth layer only ─────
create table webauthn_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  credential_id text not null unique,          -- base64url
  public_key_jwk jsonb not null,
  sign_count bigint not null default 0,
  name text not null default '',
  transports text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create table auth_challenges (
  id text primary key,                          -- sha256 of the random handle kept in a cookie
  purpose text not null check (purpose in ('webauthn_register','webauthn_login','oidc')),
  user_id uuid references users(id) on delete cascade,
  challenge text not null,
  data jsonb not null default '{}',
  expires_at timestamptz not null
);
create table oidc_providers (
  id text primary key,                          -- slug, e.g. "google"
  name text not null,
  issuer text not null,
  client_id text not null,
  client_secret_enc bytea,
  scopes text not null default 'openid email profile',
  allow_signup boolean not null default false,
  enabled boolean not null default true
);
create table oidc_identities (
  provider_id text not null references oidc_providers(id) on delete cascade,
  subject text not null,
  user_id uuid not null references users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  primary key (provider_id, subject)
);
