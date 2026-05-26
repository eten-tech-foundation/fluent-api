# Fluent API

The backend/server for the Fluent ecosystem built with Hono and OpenAPI. This is a fully documented, type-safe JSON API with automatic OpenAPI documentation generation.

- [Tech Stack](#tech-stack)
- [Setup](#setup)
- [Development](#development)
- [Code Tour](#code-tour)
- [API Endpoints](#api-endpoints)
- [Contributing](#contributing)
- [References](#references)

## Tech Stack

### Core Framework

- **[Hono](https://hono.dev/)** - Fast, lightweight web framework
- **[@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)** - OpenAPI 3.0 integration with Zod validation
- **[TypeScript](https://www.typescriptlang.org/)** - Type-safe development

### Database & ORM

- **[Drizzle ORM](https://orm.drizzle.team/)** - Type-safe ORM with PostgreSQL support
- **[drizzle-zod](https://orm.drizzle.team/docs/zod)** - Zod schema generation from database tables
- **[PostgreSQL](https://www.postgresql.org/)** - Primary database

### Validation & Schemas

- **[Zod](https://zod.dev/)** - Runtime type validation and schema definition
- **[drizzle-zod](https://orm.drizzle.team/docs/zod)** - Database schema to Zod schema conversion

### Documentation

- **[Scalar](https://scalar.com/)** - Interactive API documentation
- **OpenAPI 3.0** - Automatic API specification generation

### Development Tools

- **[Vitest](https://vitest.dev/)** - Fast unit testing framework
- **[ESLint](https://eslint.org/)** with **[@antfu/eslint-config](https://github.com/antfu/eslint-config)** - Code linting
- **[Prettier](https://prettier.io/)** - Code formatting
- **[pino](https://getpino.io/)** - Structured logging

### Utilities

- **[stoker](https://www.npmjs.com/package/stoker)** - OpenAPI helpers and utilities
- **[tsx](https://github.com/esbuild-kit/tsx)** - Fast TypeScript execution

### Authentication & Security

- **[Better Auth](https://www.better-auth.com/)** - Self-hosted authentication and authorization platform

## 📚 Documentation

- **[Developer Documentation](./docs/README.md)** - Complete guides for API development

- **[Authentication Migration](./docs/authentication-migration.md)** - Guide for BetterAuth migration and admin tools

- **[Quick Reference](./docs/quick-reference.md)** - Common patterns and examples

## Setup

1. **Prerequisites:**
   - **Node.js 24.14.0** or higher
   - PostgreSQL (local or cloud instance)

2. **Clone and install dependencies:**

   ```bash
   git clone <repository-url>
   cd fluent-api
   npm install
   ```

3. **Set up environment variables:**

   ```bash
   cp .env.example .env
   # Edit .env with your database credentials
   ```

   Required environment variables:

   ```env
   NODE_ENV=development
   PORT=9999
   LOG_LEVEL=info
   DATABASE_URL=postgresql://user:password@localhost:5432/dbname
   BETTER_AUTH_SECRET=generate-a-32-character-secret-key
   BETTER_AUTH_URL=http://localhost:9999/api/auth
   ```

4. **Set up a local database:**

   Install Postgres locally, create a database, and update your `.env`:

   ```env
   DATABASE_URL=postgresql://user:password@localhost:5432/scribe_dev
   ```

5. **Run database migrations:**

   ```bash
   npm run db:migrate
   ```

6. **Start development server:**

   ```bash
   npm run dev
   ```

7. **View API documentation:**
   - Open [http://localhost:9999/reference](http://localhost:9999/reference) for interactive API docs
   - Open [http://localhost:9999/doc](http://localhost:9999/doc) for OpenAPI specification

## Development

```bash
# Development server with hot reload
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Code formatting
npm run format
npm run format:check

# Testing
npm run test
npm run test --watch

# Build for production
npm run build

# Production server
npm run start

# Database
npm run db:migrate            # Apply pending migrations
npm run db:generate <name>    # Generate a new named migration
npm run db:studio             # Open Drizzle Studio
```

## Code Tour

### Project Structure

```
src/
├── routes/              # OpenAPI route definitions
├── handlers/            # Business logic handlers
├── db/                  # Database schema and configuration
├── lib/                 # Utility functions and configuration
├── middlewares/         # Custom middleware
├── server/              # Server configuration
├── test/                # Test utilities
├── app.ts               # Main application setup
├── index.ts             # Application entry point
└── env.ts               # Environment configuration
```

### Key Files

- **[index.ts](./src/index.ts)** - Application entry point using `@hono/node-server`
- **[app.ts](./src/app.ts)** - Main Hono application setup and OpenAPI configuration
- **[env.ts](./src/env.ts)** - Environment variable validation with Zod
- **[src/server/server.ts](./src/server/server.ts)** - Base server configuration with middleware
- **[src/db/schema.ts](./src/db/schema.ts)** - Database schema definitions with Drizzle
- **[src/lib/configure-open-api.ts](./src/lib/configure-open-api.ts)** - OpenAPI documentation setup

### Architecture Pattern

The project follows a **route-handler** architecture:

1. **Routes** (`src/routes/`) - Define OpenAPI routes with validation schemas
2. **Handlers** (`src/handlers/`) - Contain business logic and database operations
3. **Database** (`src/db/`) - Schema definitions and database connection
4. **Utilities** (`src/lib/`) - Shared utilities and configuration

### Example Implementation

The project includes a complete **Tasks** feature implementation demonstrating the architecture. See the following files for reference:

- **Database Schema**: [`src/db/schema.ts`](./src/db/schema.ts) - Table definitions and Zod validation schemas
- **Handler Functions**: [`src/handlers/task.handler.ts`](./src/handlers/task.handler.ts) - Business logic and database operations
- **Route Definitions**: [`src/routes/task.route.ts`](./src/routes/task.route.ts) - OpenAPI route specifications
- **Tests**: [`src/handlers/task.handler.test.ts`](./src/handlers/task.handler.test.ts) - Handler testing patterns

## API Endpoints

### Public Endpoints

| Method | Path          | Description              |
| ------ | ------------- | ------------------------ |
| GET    | `/`           | API Index                |
| GET    | `/health`     | Health Check             |
| GET    | `/doc`        | OpenAPI Specification    |
| GET    | `/reference`  | Scalar API Documentation |
| GET    | `/api/public` | Public data (no auth)    |

### Protected Endpoints (Require valid BetterAuth session)

| Method | Path             | Description         |
| ------ | ---------------- | ------------------- |
| GET    | `/api/protected` | Protected user data |

### Task Management (Examples)

| Method | Path          | Description           |
| ------ | ------------- | --------------------- |
| GET    | `/tasks`      | List all tasks        |
| POST   | `/tasks`      | Create a task         |
| GET    | `/tasks/{id}` | Get one task by id    |
| PATCH  | `/tasks/{id}` | Update one task by id |
| DELETE | `/tasks/{id}` | Delete one task by id |

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed information about:

- Project architecture and patterns
- Adding new features
- Testing guidelines
- Code style and conventions
- Pull request process

## References

### Core Technologies

- [Hono Documentation](https://hono.dev/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Zod Documentation](https://zod.dev/)
- [Vitest Documentation](https://vitest.dev/)

### OpenAPI & Documentation

- [What is OpenAPI?](https://swagger.io/docs/specification/v3_0/about/)
- [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)
- [Scalar Documentation](https://github.com/scalar/scalar)

### Development Tools

- [ESLint Antfu Config](https://github.com/antfu/eslint-config)
- [Stoker Utilities](https://www.npmjs.com/package/stoker)
