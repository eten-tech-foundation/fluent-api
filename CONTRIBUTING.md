# Contributing Guide

Welcome to the Fluent API repository! This guide will help you understand the project structure and development process based on the actual codebase.

## Table of Contents

- [Project Structure](#project-structure)
- [Development Setup](#development-setup)
- [Adding a New Feature](#adding-a-new-feature)
- [Testing](#testing)
- [Database Changes](#database-changes)
- [Code Style](#code-style)
- [Pull Request Process](#pull-request-process)

## Project Structure

Code is organized by business domain under `src/domains/{domain}/`, each with its own
route, service, repository, types and policy files. Shared infrastructure lives in
`src/lib/`, `src/middlewares/` and `src/db/`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
layout, layer responsibilities and sub-domain leaf rules.

## Development Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Set up environment variables:**

   ```bash
   cp .env.example .env
   # Edit .env with your database credentials
   ```

   Required environment variables (see `src/env.ts`):

   ```env
   NODE_ENV=development
   PORT=9999
   LOG_LEVEL=info
   DATABASE_URL=postgresql://user:password@localhost:5432/dbname
   ```

3. **Set up a local database:**

   Install Postgres locally, create a database, and update your `.env`:

   ```env
   DATABASE_URL=postgresql://user:password@localhost:5432/scribe_dev
   ```

4. **Run database migrations:**

   ```bash
   npm run db:migrate
   ```

5. **Start development server:**

   ```bash
   npm run dev
   ```

6. **Run tests:**

   ```bash
   npm run test
   ```

## Adding a New Feature

Follow [ARCHITECTURE.md](ARCHITECTURE.md) for structure and
[docs/guides/code-standards.md](docs/guides/code-standards.md) for the rules every PR is
checked against. The **Users** domain (`src/domains/users/`) is the reference for
authentication (`authenticateUser`), authorization (`requirePermission` plus a domain
policy), and route and service tests.

1. **Database schema**: add your table(s) to `src/db/schema.ts`.
2. **Migration**: run `npm run db:generate <name>`, then `npm run db:migrate`.
3. **Domain folder**: create `src/domains/{feature}/`, or a leaf under an existing domain.
4. **Implementation**: add `{feature}.types.ts`, `.repository.ts`, `.service.ts` and `.route.ts`.
5. **Registration**: import the route file in `src/app.ts`.
6. **Tests**: service tests with a mocked repository, route tests with mocked services,
   and `*.integration.test.ts` (PGlite) for repository SQL.

## Testing

### Test Structure

We use **Vitest**. Tests sit next to the code they test:

- `*.test.ts` — service and route tests with mocked repository/service boundaries
- `*.integration.test.ts` — database-backed tests with real repository SQL (PGlite)

See [Testing Patterns](ARCHITECTURE.md#testing-patterns) and
[Database-Backed Integration Tests](ARCHITECTURE.md#database-backed-integration-tests).
Unit tests never mock `@/db` and never use `any` (FA-L6, FA-L7 in
[code-standards.md](docs/guides/code-standards.md)).

### Test Utilities

`src/test/utils/test-helpers.ts` provides `createMockContext()`, sample fixtures
(`sampleUsers`, `sampleProjects`, `sampleChapterAssignments`, …) and `resetAllMocks()`.
Prefer a small factory function over a partial cast (`{ id: 2 } as X`) when a test needs a
variant.

### Running Tests

```bash
npm run test                 # watch mode
npm run test -- --run        # single run
npm run test -- --coverage
```

## Database Changes

Migrations are managed with Drizzle Kit and live in `src/db/migrations/`.

### Creating a migration

Always generate migrations with a descriptive name. **Never rename migration files manually after generation** — this breaks the `_journal.json` tracking file and prevents migrations from running correctly.

```bash
npm run db:generate <descriptive_name>

# Example
npm run db:generate add_chapter_assignment_history_tracking
# Generates: src/db/migrations/000X_add_chapter_assignment_history_tracking.sql
```

This automatically updates `_journal.json` with the correct tag.

### Applying migrations

```bash
npm run db:migrate
```

### Viewing your database

```bash
npm run db:studio
```

### Environment variables

Database configuration is handled through environment variables in `src/env.ts`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/dbname
```

The app validates all required environment variables on startup and will fail if any are missing.

### ⚠️ Rules

- Always use `npm run db:generate <name>` — never rename `.sql` files after generation
- Never edit an existing migration file — create a new one instead
- Every schema change must have a corresponding migration file committed alongside it
- Always run and verify migrations locally before pushing

## Code Style

### ESLint and Prettier

The project uses ESLint with `@antfu/eslint-config` and Prettier:

```bash
# Check linting
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

### TypeScript

- Strict TypeScript configuration (`npm run typecheck`)
- `interface` for object shapes, `type` for unions, aliases and `z.infer<>`; see
  [interface vs type](docs/guides/code-standards.md#interface-vs-type)
- No `any`; use `unknown` and narrow

### Naming Conventions

- **Files**: `kebab-case` (e.g., `chapter-assignments.service.ts`, `user-projects.route.ts`)
- **Functions**: `camelCase` (e.g., `getAllTasks`, `createTask`)
- **Variables**: `camelCase` (e.g., `projectUnit`, `userId`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `ZOD_ERROR_CODES`)

### Import Organization

Import order is enforced by `perfectionist/sort-imports`; run `npm run lint:fix`.

## Pull Request Process

1. **Fork the repository** and create a feature branch
2. **Make your changes** following the guidelines above
3. **Add tests** for new functionality
4. **Run `npm run verify`** and walk the FA-R checklist (see [Before Opening a PR](#before-opening-a-pr))
5. **Submit a pull request** with a clear description

### Commit Messages

Use conventional commits format:

```
feat: add user management endpoints
fix: resolve database connection issue
docs: update API documentation
test: add tests for user handler
refactor: simplify route error handling
```

### Before Opening a PR

```bash
npm run verify   # lint, format check, typecheck, tests, dead code, docs structure, build
```

Then walk the FA-R checklist in
[docs/guides/code-standards.md](docs/guides/code-standards.md#before-opening-a-pr).

## Getting Help

- Check the [README.md](./README.md) for basic setup
- Use `src/domains/users/` as the reference implementation
- Open an issue for bugs or feature requests

## Additional Resources

- [Hono Documentation](https://hono.dev/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Vitest Documentation](https://vitest.dev/)
- [Zod Documentation](https://zod.dev/)
- [Stoker Documentation](https://www.npmjs.com/package/stoker)

Happy coding! 🚀
