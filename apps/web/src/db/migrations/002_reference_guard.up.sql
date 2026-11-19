-- Defence in depth against IDOR via foreign keys (NFR-SEC-10/11).
-- PostgreSQL FK checks bypass RLS, so without this a user could reference another user's account/bucket/…
-- by guessing its UUID. These triggers run as the invoking role (hearth_app) and therefore see only rows
-- RLS allows; a reference to an inaccessible row raises an error.

create function hearth_check_ref(tbl text, ref uuid, need_write boolean) returns void language plpgsql as $$
declare ok boolean;
begin
  if ref is null or hearth_uid() is null then return; end if; -- system context (migrations, jobs as owner)
  execute format('select %s from %I where id = $1',
                 case when need_write then 'hearth_can_write(owner_id, household_id)' else 'hearth_can_read(owner_id, household_id)' end, tbl)
    into ok using ref;
  if ok is not true then
    raise exception 'referenced % row is not accessible', tbl using errcode = '42501';
  end if;
end $$;

create function trg_ref_transactions() returns trigger language plpgsql as $$
begin
  perform hearth_check_ref('accounts', new.account_id, true);
  perform hearth_check_ref('accounts', new.to_account_id, true);
  perform hearth_check_ref('categories', new.category_id, false);
  perform hearth_check_ref('buckets', new.bucket_id, true);
  return new;
end $$;
create trigger ref_guard before insert or update on transactions for each row execute function trg_ref_transactions();

create function trg_ref_bucket_movements() returns trigger language plpgsql as $$
begin perform hearth_check_ref('buckets', new.bucket_id, true); return new; end $$;
create trigger ref_guard before insert or update on bucket_movements for each row execute function trg_ref_bucket_movements();

create function trg_ref_buckets() returns trigger language plpgsql as $$
begin
  perform hearth_check_ref('accounts', new.linked_account_id, false);
  perform hearth_check_ref('portfolios', new.linked_portfolio_id, false);
  perform hearth_check_ref('buckets', new.rollover_bucket_id, true);
  return new;
end $$;
create trigger ref_guard before insert or update on buckets for each row execute function trg_ref_buckets();

create function trg_ref_debts() returns trigger language plpgsql as $$
begin
  perform hearth_check_ref('buckets', new.bucket_id, true);
  if new.owner_member_id is not null and not exists (select 1 from members where id = new.owner_member_id) then
    raise exception 'referenced member is not accessible' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger ref_guard before insert or update on debts for each row execute function trg_ref_debts();

create function trg_ref_by_debt() returns trigger language plpgsql as $$
begin perform hearth_check_ref('debts', new.debt_id, true); return new; end $$;
create trigger ref_guard before insert or update on debt_payments for each row execute function trg_ref_by_debt();
create trigger ref_guard before insert or update on debt_rate_schedule for each row execute function trg_ref_by_debt();
create trigger ref_guard before insert or update on debt_responsibilities for each row execute function trg_ref_by_debt();

create function trg_ref_goals() returns trigger language plpgsql as $$
begin
  perform hearth_check_ref('buckets', new.bucket_id, false);
  perform hearth_check_ref('accounts', new.account_id, false);
  return new;
end $$;
create trigger ref_guard before insert or update on goals for each row execute function trg_ref_goals();

create function trg_ref_goal_contrib() returns trigger language plpgsql as $$
begin perform hearth_check_ref('goals', new.goal_id, true); return new; end $$;
create trigger ref_guard before insert or update on goal_contributions for each row execute function trg_ref_goal_contrib();

create function trg_ref_inv() returns trigger language plpgsql as $$
begin
  perform hearth_check_ref('portfolios', new.portfolio_id, true);
  perform hearth_check_ref('assets', new.asset_id, true);
  perform hearth_check_ref('buckets', new.source_bucket_id, true);
  return new;
end $$;
create trigger ref_guard before insert or update on investment_transactions for each row execute function trg_ref_inv();

create function trg_ref_asset() returns trigger language plpgsql as $$
begin perform hearth_check_ref('assets', new.asset_id, true); return new; end $$;
create trigger ref_guard before insert or update on price_history for each row execute function trg_ref_asset();

create function trg_ref_dca() returns trigger language plpgsql as $$
begin
  perform hearth_check_ref('portfolios', new.portfolio_id, true);
  perform hearth_check_ref('assets', new.asset_id, true);
  return new;
end $$;
create trigger ref_guard before insert or update on dca_plans for each row execute function trg_ref_dca();

create function trg_ref_recurring() returns trigger language plpgsql as $$
begin
  perform hearth_check_ref('accounts', new.account_id, true);
  perform hearth_check_ref('accounts', new.to_account_id, true);
  perform hearth_check_ref('categories', new.category_id, false);
  perform hearth_check_ref('buckets', new.bucket_id, true);
  perform hearth_check_ref('debts', new.debt_id, true);
  return new;
end $$;
create trigger ref_guard before insert or update on recurring_rules for each row execute function trg_ref_recurring();

create function trg_ref_category() returns trigger language plpgsql as $$
begin perform hearth_check_ref('categories', new.category_id, false); return new; end $$;
create trigger ref_guard before insert or update on budget_lines for each row execute function trg_ref_category();
create trigger ref_guard before insert or update on categorize_rules for each row execute function trg_ref_category();

create function trg_ref_category_parent() returns trigger language plpgsql as $$
begin perform hearth_check_ref('categories', new.parent_id, true); return new; end $$;
create trigger ref_guard before insert or update on categories for each row execute function trg_ref_category_parent();

create function trg_ref_portfolio() returns trigger language plpgsql as $$
begin perform hearth_check_ref('goals', new.goal_id, false); return new; end $$;
create trigger ref_guard before insert or update on portfolios for each row execute function trg_ref_portfolio();
