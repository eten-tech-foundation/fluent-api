#!/bin/sh
set -e

echo "Bootstrapping database roles/schemas..."
npx tsx src/db/scripts/bootstrap.ts || { echo "ERROR: db bootstrap failed"; exit 1; }

echo "Running database migrations..."
npx drizzle-kit migrate || { echo "ERROR: database migrations failed"; exit 1; }

echo "Seeding roles..."
npx tsx src/db/seeds/roles.ts || { echo "ERROR: roles seed failed"; exit 1; }

echo "Seeding RBAC data..."
npx tsx src/db/seeds/rbac.ts || { echo "ERROR: RBAC seed failed"; exit 1; }

echo "Starting dev server..."
exec npx tsx watch src/index.ts
