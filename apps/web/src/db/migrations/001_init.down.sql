drop table if exists attachments, net_worth_snapshots, notifications, recurring_rules, budget_lines, dca_plans,
  allocation_targets, price_history, investment_transactions, assets, portfolios, emergency_events, goal_contributions,
  goals, debt_plans, debt_payments, debt_responsibilities, debt_rate_schedule, debts, categorize_rules,
  bucket_movements, transaction_splits, transactions, buckets, categories, accounts, user_preferences, activity_log,
  household_invites, members, households, audit_log, support_grants, instance_settings, email_tokens, sessions,
  recovery_codes, users cascade;
drop function if exists txn_apply_balance, bucket_apply_balance, audit_log_immutable, hearth_can_manage,
  hearth_can_write, hearth_can_read, hearth_member_role, hearth_uid cascade;
