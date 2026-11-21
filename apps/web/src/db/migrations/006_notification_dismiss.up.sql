-- Deleting a notification in the app. Rows that carry a dedupe_key are only hidden (dismissed_at), because the
-- scheduler uses that key to avoid sending the same alert again; rows without one are deleted outright.
alter table notifications add column dismissed_at timestamptz;
