-- Fluent API — standalone database bootstrap.
-- Run automatically on first postgres container start via docker-entrypoint-initdb.d.
-- In ecosystem mode, the API self-provisions via migrations; this script is not used.
-- ================================================================

CREATE USER IF NOT EXISTS web_user WITH PASSWORD 'password';
CREATE SCHEMA IF NOT EXISTS pgboss;

-- public already exists; ensure web_user owns it for Drizzle migrations
ALTER SCHEMA public OWNER TO web_user;
ALTER SCHEMA pgboss OWNER TO web_user;

GRANT USAGE, CREATE ON SCHEMA public  TO web_user;
GRANT USAGE, CREATE ON SCHEMA pgboss TO web_user;
