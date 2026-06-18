#!/bin/sh
set -e

echo "Bootstrapping database roles/schemas..."
npx tsx src/db/scripts/bootstrap.ts || { echo "ERROR: db bootstrap failed"; exit 1; }

echo "Running database migrations..."
npx drizzle-kit migrate || { echo "ERROR: database migrations failed"; exit 1; }

echo "Seeding organizations..."
npx tsx src/db/seeds/organizations.ts || { echo "ERROR: organizations seed failed"; exit 1; }

echo "Seeding roles..."
npx tsx src/db/seeds/roles.ts || { echo "ERROR: roles seed failed"; exit 1; }

echo "Seeding RBAC data..."
npx tsx src/db/seeds/rbac.ts || { echo "ERROR: RBAC seed failed"; exit 1; }

echo "Seeding dev users..."
npx tsx src/db/seeds/dev-users.ts || { echo "ERROR: dev users seed failed"; exit 1; }

echo "Seeding languages..."
npx tsx src/db/seeds/languages.ts || { echo "ERROR: languages seed failed"; exit 1; }

echo "Seeding books..."
npx tsx src/db/seeds/books.ts || { echo "ERROR: books seed failed"; exit 1; }

echo "Seeding bibles..."
npx tsx src/db/seeds/bibles.ts || { echo "ERROR: bibles seed failed"; exit 1; }

echo "Seeding bible texts..."
npx tsx src/db/seeds/bible-texts.ts || { echo "ERROR: bible texts seed failed"; exit 1; }

echo "Starting dev server..."
exec npx tsx watch src/index.ts
