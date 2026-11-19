#!/bin/sh
# Creates the application login role as a NON-superuser that owns the database.
# Runtime queries additionally switch to the RLS-restricted role "hearth_app" (created by migrations).
set -eu
APP_PASSWORD="$(cat /run/secrets/db_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE hearth LOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${APP_PASSWORD}';
CREATE DATABASE hearth OWNER hearth;
REVOKE ALL ON DATABASE hearth FROM PUBLIC;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname hearth <<SQL
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO hearth;
SQL
