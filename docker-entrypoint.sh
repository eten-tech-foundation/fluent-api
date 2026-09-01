#!/bin/sh
set -e

echo "Bootstrapping database roles/schemas..."
npx tsx src/db/scripts/bootstrap.ts || { echo "ERROR: db bootstrap failed"; exit 1; }

echo "Running setup (migrations + seeds)..."
SETUP_ENV=local npx tsx src/db/scripts/setup.ts || { echo "ERROR: db setup failed"; exit 1; }

echo "Starting dev server..."
exec npx tsx watch src/index.ts
