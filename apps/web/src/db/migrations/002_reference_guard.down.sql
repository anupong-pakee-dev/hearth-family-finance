do $$
declare t text;
begin
  foreach t in array array['transactions','bucket_movements','buckets','debts','debt_payments','debt_rate_schedule','debt_responsibilities','goals',
    'goal_contributions','investment_transactions','price_history','dca_plans','recurring_rules','budget_lines','categorize_rules','categories','portfolios']
  loop
    execute format('drop trigger if exists ref_guard on %I', t);
  end loop;
end $$;
drop function if exists trg_ref_transactions, trg_ref_bucket_movements, trg_ref_buckets, trg_ref_debts, trg_ref_by_debt, trg_ref_goals,
  trg_ref_goal_contrib, trg_ref_inv, trg_ref_asset, trg_ref_dca, trg_ref_recurring, trg_ref_category, trg_ref_category_parent, trg_ref_portfolio;
drop function if exists hearth_check_ref(text, uuid, boolean);
