-- User-chosen colour palette (Settings › Colours & theme). '{}' = the default palette.
-- Keys: preset, primary, inc, exp, heat, c1..c5 — values are #rrggbb, validated by the app.
alter table user_preferences add column colors jsonb not null default '{}';
