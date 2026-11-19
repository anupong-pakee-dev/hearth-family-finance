drop table if exists oidc_identities, oidc_providers, auth_challenges, webauthn_credentials, notification_channels, push_subscriptions;
alter table user_preferences drop column if exists last_summary_sent, drop column if exists tax_limits;
alter table debts drop column if exists lender_member_id;
alter table goals drop column if exists challenge, drop column if exists challenge_step, drop column if exists challenge_start;
alter table assets drop column if exists price_source, drop column if exists tax_type;
alter table investment_transactions drop column if exists pending, drop column if exists dca_plan_id;
drop view if exists transaction_lines;
drop function if exists hearth_fx(text, text);
drop table if exists exchange_rates;
