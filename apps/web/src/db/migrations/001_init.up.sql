-- Hearth Family Finance — initial schema
-- Money: bigint minor units (satang). Rates: integer percent × 10 000. Units/prices: bigint × 1e8.
-- Every financial table carries owner_id + household_id (NULL = private) and is protected by RLS
-- (NFR-SEC-10). The application switches to role hearth_app and sets app.user_id per request.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hearth_app') then
    create role hearth_app nologin;
  end if;
end $$;
grant hearth_app to current_user;

-- ───────────────────────── Identity (accessed by the auth layer, not by hearth_app) ─────────────────────────
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_verified_at timestamptz,
  password_hash text not null,
  display_name text not null default '',
  is_admin boolean not null default false,
  totp_secret_enc bytea,
  totp_enabled boolean not null default false,
  totp_last_step bigint,
  data_key_enc bytea,              -- per-user data key wrapped by the master key (NFR-SEC-14)
  data_key_version text,
  failed_logins int not null default 0,
  locked_until timestamptz,
  disabled boolean not null default false,
  delete_requested_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz
);

create table sessions (
  id text primary key,                -- sha256(token); raw token only lives in the cookie
  user_id uuid not null references users(id) on delete cascade,
  csrf_token text not null,
  mfa_pending boolean not null default false,
  reauth_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text,
  user_agent text,
  device_hash text
);
create index sessions_user_idx on sessions(user_id);

create table email_tokens (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('verify', 'reset')),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table instance_settings (
  key text primary key,
  value jsonb not null
);
insert into instance_settings(key, value) values
  ('open_registration', 'true'),
  ('enforce_2fa', 'false'),
  ('session_idle_minutes', '30');

create table support_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  granted_to uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Append-only, hash-chained audit log (NFR-SEC-33)
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  detail jsonb not null default '{}',
  ip text,
  prev_hash text not null,
  hash text not null
);
create index audit_user_idx on audit_log(user_id, at desc);
create function audit_log_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

-- ───────────────────────── RLS helpers ─────────────────────────
create function hearth_uid() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ───────────────────────── Households ─────────────────────────
create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,         -- NULL = dependent (no login)
  display_name text not null,
  role text not null check (role in ('owner','manager','member','viewer','dependent')),
  joined_bucket_sharing boolean not null default true,
  created_at timestamptz not null default now(),
  unique (household_id, user_id)
);
create index members_user_idx on members(user_id);

create function hearth_member_role(hh uuid) returns text language sql stable security definer
set search_path = public as $$
  select role from members where household_id = hh and user_id = hearth_uid()
$$;
create function hearth_can_read(owner uuid, hh uuid) returns boolean language sql stable as $$
  select owner = hearth_uid() or (hh is not null and hearth_member_role(hh) is not null)
$$;
create function hearth_can_write(owner uuid, hh uuid) returns boolean language sql stable as $$
  select owner = hearth_uid() or (hh is not null and hearth_member_role(hh) in ('owner','manager','member'))
$$;
create function hearth_can_manage(hh uuid) returns boolean language sql stable as $$
  select hearth_member_role(hh) in ('owner','manager')
$$;

create table household_invites (
  token_hash text primary key,
  household_id uuid not null references households(id) on delete cascade,
  role text not null check (role in ('manager','member','viewer')),
  email text,
  created_by uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table activity_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references households(id) on delete cascade,
  owner_id uuid not null,
  actor_id uuid not null,
  action text not null,
  entity text not null,
  entity_id uuid,
  summary text not null default '',
  at timestamptz not null default now()
);
create index activity_hh_idx on activity_log(household_id, at desc);

-- ───────────────────────── Preferences ─────────────────────────
create table user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  locale text not null default 'th' check (locale in ('th','en')),
  currency char(3) not null default 'THB',
  date_era text not null default 'be' check (date_era in ('be','ce')),
  month_start_day smallint not null default 1 check (month_start_day between 1 and 28),
  theme text not null default 'system' check (theme in ('system','light','dark')),
  privacy_mode boolean not null default false,
  bucket_mode text not null default 'off' check (bucket_mode in ('off','partial','full')),
  investment_enabled boolean,
  onboarded boolean not null default false,
  monthly_income bigint not null default 0,
  dsr_threshold_e4 int not null default 400000,
  budget_warn_e4 int not null default 800000,
  emergency_mode text not null default 'months' check (emergency_mode in ('months','fixed')),
  emergency_months numeric(4,1) not null default 6,
  emergency_fixed bigint not null default 0,
  emergency_source text not null default 'manual' check (emergency_source in ('bucket','account','manual')),
  emergency_account_id uuid,
  emergency_manual bigint not null default 0,
  essential_override bigint,
  emergency_first boolean not null default true,
  invest_warn_rate_e4 int not null default 150000,
  invest_monthly_budget bigint not null default 0,
  cost_method text not null default 'average' check (cost_method in ('average','fifo')),
  networth_exclude text[] not null default '{}',
  scenario_rates numeric[] not null default '{3,6,9}',
  notify_prefs jsonb not null default '{}',
  dashboard_hidden text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- ───────────────────────── Accounts, categories, transactions ─────────────────────────
create table accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  name text not null,
  type text not null check (type in ('cash','savings','fixed_deposit','ewallet','credit_card','investment')),
  currency char(3) not null default 'THB',
  opening_balance bigint not null default 0,
  balance bigint not null default 0,
  account_no_enc bytea,
  is_liquid boolean not null default true,
  archived boolean not null default false,
  reconciled_balance bigint,
  reconciled_at date,
  created_at timestamptz not null default now()
);
create index accounts_owner_idx on accounts(owner_id);

create table categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  parent_id uuid references categories(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('income','expense')),
  essential boolean not null default false,
  sort int not null default 0,
  archived boolean not null default false
);
create index categories_owner_idx on categories(owner_id);

create table buckets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  name text not null,
  icon text not null default 'jar',
  color text not null default '#2f6f5e',
  type text not null check (type in ('bills','spending','savings','emergency','debt','investing')),
  balance bigint not null default 0,
  monthly_target bigint,
  rollover_policy text not null default 'carry' check (rollover_policy in ('carry','return','to_bucket')),
  rollover_bucket_id uuid references buckets(id) on delete set null,
  linked_account_id uuid references accounts(id) on delete set null,
  linked_portfolio_id uuid,
  auto_percent_e4 int,
  auto_fixed bigint,
  auto_priority int,
  archived boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index buckets_owner_idx on buckets(owner_id);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  kind text not null check (kind in ('income','expense','transfer')),
  date date not null,
  amount bigint not null check (amount > 0),
  currency char(3) not null default 'THB',
  fx_rate numeric(18,8),
  account_id uuid not null references accounts(id) on delete cascade,
  to_account_id uuid references accounts(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  bucket_id uuid references buckets(id) on delete set null,      -- always nullable: buckets are optional
  payee text,
  note_enc bytea,
  tags text[] not null default '{}',
  import_hash text,
  recurring_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  check (kind <> 'transfer' or to_account_id is not null)
);
create index txn_owner_date_idx on transactions(owner_id, date desc, created_at desc);
create index txn_hh_date_idx on transactions(household_id, date desc) where household_id is not null;
create index txn_category_idx on transactions(category_id);
create index txn_import_idx on transactions(owner_id, import_hash) where import_hash is not null;

create table transaction_splits (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  owner_id uuid not null,
  household_id uuid,
  category_id uuid references categories(id) on delete set null,
  bucket_id uuid references buckets(id) on delete set null,
  amount bigint not null
);

create table bucket_movements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  bucket_id uuid not null references buckets(id) on delete cascade,
  amount bigint not null,                -- + into bucket, − out of bucket
  kind text not null check (kind in ('allocate','move','spend','income','adjust','rollover','invest')),
  transaction_id uuid references transactions(id) on delete cascade,
  note text,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index bucket_mov_idx on bucket_movements(bucket_id, created_at desc);

-- Keep account and bucket balances as snapshots (NFR-PERF-19)
create function txn_apply_balance() returns trigger language plpgsql as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    if old.kind = 'income' then update accounts set balance = balance - old.amount where id = old.account_id;
    elsif old.kind = 'expense' then update accounts set balance = balance + old.amount where id = old.account_id;
    else
      update accounts set balance = balance + old.amount where id = old.account_id;
      update accounts set balance = balance - old.amount where id = old.to_account_id;
    end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    if new.kind = 'income' then update accounts set balance = balance + new.amount where id = new.account_id;
    elsif new.kind = 'expense' then update accounts set balance = balance - new.amount where id = new.account_id;
    else
      update accounts set balance = balance - new.amount where id = new.account_id;
      update accounts set balance = balance + new.amount where id = new.to_account_id;
    end if;
  end if;
  return null;
end $$;
create trigger txn_balance after insert or update or delete on transactions
  for each row execute function txn_apply_balance();

create function bucket_apply_balance() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    update buckets set balance = balance - old.amount where id = old.bucket_id;
    return null;
  end if;
  update buckets set balance = balance + new.amount where id = new.bucket_id;
  return null;
end $$;
create trigger bucket_mov_balance after insert or delete on bucket_movements
  for each row execute function bucket_apply_balance();

create table categorize_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  pattern text not null,
  category_id uuid not null references categories(id) on delete cascade
);

-- ───────────────────────── Debts ─────────────────────────
create table debts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  owner_member_id uuid references members(id) on delete set null,   -- contractual debtor (may be a dependent)
  name text not null,
  type text not null check (type in ('credit_card','personal_loan','mortgage','auto','student','informal','family','bnpl')),
  creditor_enc bytea,
  principal_original bigint not null,
  balance_current bigint not null,
  interest_method text not null check (interest_method in ('reducing','flat','credit_card','none')),
  annual_rate_e4 int not null default 0,
  daily_accrual boolean not null default false,
  payment_amount bigint not null default 0,
  min_payment_type text not null default 'fixed' check (min_payment_type in ('fixed','percent_of_balance')),
  min_payment_value bigint not null default 0,        -- satang or percent e4
  min_payment_floor bigint not null default 0,
  due_day smallint check (due_day between 1 and 31),
  start_date date,
  term_months int,
  visibility text not null default 'full' check (visibility in ('private','summary','full')),
  bucket_id uuid references buckets(id) on delete set null,
  is_receivable boolean not null default false,       -- FR-DEBT-16: someone owes us
  guarantor text,
  plan_payoff_date date,
  closed_at date,
  created_at timestamptz not null default now()
);
create index debts_owner_idx on debts(owner_id);

create table debt_rate_schedule (
  id uuid primary key default gen_random_uuid(),
  debt_id uuid not null references debts(id) on delete cascade,
  owner_id uuid not null, household_id uuid,
  from_date date not null,
  annual_rate_e4 int not null
);

create table debt_responsibilities (
  id uuid primary key default gen_random_uuid(),
  debt_id uuid not null references debts(id) on delete cascade,
  owner_id uuid not null, household_id uuid,
  member_id uuid not null references members(id) on delete cascade,
  share_percent_e4 int,
  share_amount bigint
);

create table debt_payments (
  id uuid primary key default gen_random_uuid(),
  debt_id uuid not null references debts(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  date date not null,
  amount bigint not null check (amount > 0),
  principal bigint not null default 0,
  interest bigint not null default 0,
  fee bigint not null default 0,
  paid_by_member_id uuid references members(id) on delete set null,
  transaction_id uuid references transactions(id) on delete set null,
  balance_adjustment bigint not null default 0,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index debt_pay_idx on debt_payments(debt_id, date desc);

create table debt_plans (
  owner_id uuid primary key references users(id) on delete cascade,
  household_id uuid,
  strategy text not null default 'avalanche' check (strategy in ('snowball','avalanche','custom')),
  monthly_budget bigint not null default 0,
  custom_order uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- ───────────────────────── Goals & emergency ─────────────────────────
create table goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  name text not null,
  target_amount bigint,                -- NULL = open-ended (FR-SAVE-08)
  target_date date,
  expected_return_e4 int not null default 0,
  bucket_id uuid references buckets(id) on delete set null,
  account_id uuid references accounts(id) on delete set null,
  portfolio_id uuid,
  priority int not null default 100,
  icon text not null default 'target',
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table goal_contributions (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references goals(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  date date not null,
  amount bigint not null,
  member_id uuid references members(id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index goal_contrib_idx on goal_contributions(goal_id, date desc);

create table emergency_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  date date not null,
  amount bigint not null,              -- negative = withdrawal, positive = deposit
  reason text,
  refill_months int,
  created_at timestamptz not null default now()
);

-- ───────────────────────── Investments ─────────────────────────
create table portfolios (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  member_id uuid references members(id) on delete set null,   -- e.g. a dependent child's portfolio
  name text not null,
  kind text not null default 'brokerage',
  visibility text not null default 'private' check (visibility in ('private','total','full')),
  goal_id uuid references goals(id) on delete set null,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  symbol text not null,
  name text not null default '',
  asset_class text not null check (asset_class in ('thai_stock','foreign_stock','etf','mutual_fund','tax_fund','pvd','sso','bond','fixed_deposit','gold','crypto','real_estate','other')),
  currency char(3) not null default 'THB',
  manual_valuation boolean not null default false,
  created_at timestamptz not null default now()
);

create table investment_transactions (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  type text not null check (type in ('buy','sell','dividend','interest','fee','switch_in','switch_out','split','transfer_in','transfer_out')),
  date date not null,
  units_e8 bigint not null default 0,
  price_e8 bigint not null default 0,
  amount bigint not null default 0,
  fee bigint not null default 0,
  tax bigint not null default 0,
  currency char(3) not null default 'THB',
  fx_rate numeric(18,8),
  source_bucket_id uuid references buckets(id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index inv_txn_idx on investment_transactions(portfolio_id, date);

create table price_history (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references assets(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  date date not null,
  price_e8 bigint not null,
  source text not null default 'manual',
  unique (asset_id, date)
);

create table allocation_targets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  asset_class text not null,
  percent_e4 int not null,
  unique (owner_id, asset_class)
);

create table dca_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  amount bigint not null,
  day_of_month smallint not null default 1,
  next_date date not null,
  active boolean not null default true
);

-- ───────────────────────── Budget, recurring, notifications ─────────────────────────
create table budget_lines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  month char(7) not null,             -- YYYY-MM (cycle start month)
  category_id uuid not null references categories(id) on delete cascade,
  amount bigint not null,
  period text not null default 'monthly' check (period in ('monthly','quarterly','yearly')),
  unique (owner_id, month, category_id)
);

create table recurring_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  name text not null,
  kind text not null check (kind in ('income','expense','transfer')),
  amount bigint not null check (amount > 0),
  account_id uuid not null references accounts(id) on delete cascade,
  to_account_id uuid references accounts(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  bucket_id uuid references buckets(id) on delete set null,
  debt_id uuid references debts(id) on delete set null,
  frequency text not null check (frequency in ('daily','weekly','monthly','yearly','last_business_day')),
  interval_count int not null default 1,
  next_date date not null,
  end_date date,
  auto_create boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, dedupe_key)
);
create index notifications_owner_idx on notifications(owner_id, created_at desc);

create table net_worth_snapshots (
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  date date not null,
  assets bigint not null,
  liabilities bigint not null,
  investments bigint not null default 0,
  primary key (owner_id, date)
);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  household_id uuid,
  transaction_id uuid references transactions(id) on delete cascade,
  mime text not null,
  size int not null,
  data_enc bytea not null,
  created_at timestamptz not null default now()
);

-- ───────────────────────── Row-Level Security ─────────────────────────
do $$
declare t text;
begin
  foreach t in array array['accounts','categories','buckets','transactions','transaction_splits','bucket_movements',
    'categorize_rules','debts','debt_rate_schedule','debt_responsibilities','debt_payments','debt_plans','goals',
    'goal_contributions','emergency_events','portfolios','assets','investment_transactions','price_history',
    'allocation_targets','dca_plans','budget_lines','recurring_rules','notifications','net_worth_snapshots','attachments']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for select to hearth_app using (hearth_can_read(owner_id, household_id))', t || '_sel', t);
    execute format('create policy %I on %I for insert to hearth_app with check (hearth_can_write(owner_id, household_id))', t || '_ins', t);
    execute format('create policy %I on %I for update to hearth_app using (hearth_can_write(owner_id, household_id)) with check (hearth_can_write(owner_id, household_id))', t || '_upd', t);
    execute format('create policy %I on %I for delete to hearth_app using (hearth_can_write(owner_id, household_id))', t || '_del', t);
    execute format('grant select, insert, update, delete on %I to hearth_app', t);
  end loop;
end $$;

-- notifications are strictly personal
drop policy notifications_sel on notifications;
create policy notifications_sel on notifications for select to hearth_app using (owner_id = hearth_uid());

alter table user_preferences enable row level security;
alter table user_preferences force row level security;
create policy prefs_all on user_preferences to hearth_app using (user_id = hearth_uid()) with check (user_id = hearth_uid());
grant select, insert, update on user_preferences to hearth_app;

alter table households enable row level security;
alter table households force row level security;
create policy hh_sel on households for select to hearth_app using (created_by = hearth_uid() or hearth_member_role(id) is not null);
create policy hh_ins on households for insert to hearth_app with check (created_by = hearth_uid());
create policy hh_upd on households for update to hearth_app using (hearth_member_role(id) = 'owner');
create policy hh_del on households for delete to hearth_app using (hearth_member_role(id) = 'owner');
grant select, insert, update, delete on households to hearth_app;

alter table members enable row level security;
alter table members force row level security;
create policy mem_sel on members for select to hearth_app using (hearth_member_role(household_id) is not null);
create policy mem_ins on members for insert to hearth_app with check (
  hearth_can_manage(household_id)
  or (user_id = hearth_uid() and role = 'owner' and exists (select 1 from households h where h.id = household_id and h.created_by = hearth_uid()))
);
create policy mem_upd on members for update to hearth_app using (hearth_can_manage(household_id) or user_id = hearth_uid());
create policy mem_del on members for delete to hearth_app using (hearth_can_manage(household_id) or user_id = hearth_uid());
grant select, insert, update, delete on members to hearth_app;

alter table household_invites enable row level security;
alter table household_invites force row level security;
create policy inv_all on household_invites to hearth_app using (hearth_can_manage(household_id)) with check (hearth_can_manage(household_id));
grant select, insert, update, delete on household_invites to hearth_app;

alter table activity_log enable row level security;
alter table activity_log force row level security;
create policy act_sel on activity_log for select to hearth_app using (hearth_member_role(household_id) is not null);
create policy act_ins on activity_log for insert to hearth_app with check (actor_id = hearth_uid() and hearth_member_role(household_id) is not null);
grant select, insert on activity_log to hearth_app;
-- NOTE: hearth_app has no privileges on users/sessions/audit tables at all; identity is handled by the auth layer.
