# Architecture Overview

This document describes the high-level architecture and design patterns used in the Fluent API.

## Architectural Style

**Domain-Driven Design (DDD) inspired Modular Monolith**

The codebase follows a domain-driven, modular monolith architecture with clear business domain boundaries. While deployed as a single unit, the code is organized around business capabilities rather than technical layers.

## Project Structure

```
src/
├── domains/           # Business domains (bounded contexts)
│   ├── chapter-assignments/
│   ├── projects/
│   ├── users/
│   └── ...
├── lib/              # Shared infrastructure
├── middlewares/      # Cross-cutting concerns
└── db/               # Database layer
```

## Domain Module Pattern

Each domain is self-contained and follows a consistent internal structure:

| File                     | Responsibility                               |
| ------------------------ | -------------------------------------------- |
| `{domain}.service.ts`    | Business logic, orchestration, and use cases |
| `{domain}.repository.ts` | Data access, persistence, and queries        |
| `{domain}.route.ts`      | HTTP route handlers (presentation layer)     |
| `{domain}.types.ts`      | Domain-specific TypeScript types             |
| `{domain}.policy.ts`     | Authorization and access control rules       |
| `{domain}.middleware.ts` | Domain-specific request processing           |

### Cross-Domain Relationships

- **Internal**: Services interact with repositories within the same domain
- **Cross-Domain**: Domain services expose public functions for other domains to call
- **Avoid**: Repositories should not be accessed directly from outside their domain

## Layer Responsibilities

### Service Layer

- Encapsulates business logic and domain rules
- Orchestrates operations across multiple repositories
- Handles transactions and error management
- Returns `Result<T>` types for explicit error handling

```typescript
// Example: src/domains/chapter-assignments/chapter-assignments.service.ts
export async function createChapterAssignment(data: CreateChapterAssignmentRequestData) {
  return db.transaction(async (tx) => {
    const assignment = await repo.insert(data, tx);
    await repo.insertStatusHistory(tx, assignment.id, CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED);
    return ok(toChapterAssignmentResponse(assignment));
  });
}
```

### Repository Layer

- Handles all database operations
- Contains raw SQL queries using Drizzle ORM
- Returns plain data objects, never business objects
- Supports transactions via `DbTransaction` parameter

### Route Layer

- HTTP request handlers using Hono framework
- Validates input using Zod schemas
- Delegates to services for business logic
- Returns standardized responses

### Policy Layer

- Authorization logic for domain resources
- Evaluates user permissions against resource state
- Used by middleware for access control

## Error Handling

The project uses a **Result type pattern** for explicit error handling:

```typescript
type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorCode };
```

Services return `Result<T>` instead of throwing exceptions, forcing callers to handle both success and failure cases explicitly.

## Technology Stack

- **Framework**: [Hono](https://hono.dev/) - Lightweight web framework
- **ORM**: [Drizzle](https://orm.drizzle.team/) - Type-safe SQL
- **Database**: PostgreSQL
- **Validation**: Zod
- **Testing**: Vitest
- **Authentication**: BetterAuth (session-based middleware)

## Design Principles

1. **Domain boundaries are respected** — code within a domain should not leak abstractions
2. **Services orchestrate, repositories execute** — clear separation of concerns
3. **Explicit error handling** — Result types over exceptions for business errors
4. **Type safety** — Leverage TypeScript for compile-time correctness
5. **Minimal cross-domain dependencies** — Keep domains loosely coupled

## Type Organization

Types are distributed across files based on their scope and usage. Follow these guidelines to maintain consistency:

### `{domain}.types.ts` — The Central Type Registry

This file is the **canonical source** for domain types that are shared across layers:

| Category                     | What belongs here                                      | Examples                                                                   |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Domain Constants**         | Enums and action constants used across the domain      | `CHAPTER_ASSIGNMENT_STATUS`, `USER_ACTIONS`                                |
| **DB-Derived Types**         | Types inferred from Drizzle schema                     | `ChapterAssignmentRecord = z.infer<typeof selectChapterAssignmentsSchema>` |
| **Service Input Types**      | Interfaces for service function parameters             | `CreateChapterAssignmentRequestData`, `UpdateUserInput`                    |
| **API Response Schemas**     | Zod schemas for responses (used in routes and tests)   | `chapterAssignmentResponseSchema`                                          |
| **Reusable Request Schemas** | Zod schemas for request bodies used in multiple routes | `createUserRequestSchema`, `updateUserRequestSchema`                       |

**Guideline**: If a type is imported by more than one file in the domain, it belongs in `types.ts`.

### `{domain}.repository.ts` — Repository-Specific Types

Define types here **only** when they are:

- Specific to a single repository query (query result shapes with joins)
- Not needed outside the repository layer
- Extensions of base types for specific use cases

```typescript
// Repository-specific type for a complex join query
export interface ChapterAssignmentWithAuthContext extends ChapterAssignmentRecord {
  projectId: number;
  organizationId: number;
  isProjectMember: boolean;
}
```

**Guideline**: Keep these minimal. If another layer needs this type, move it to `types.ts`.

### `{domain}.route.ts` — Route-Specific Schemas

Route files should:

- **Import** request/response schemas from `types.ts` when they are standardized
- **Define inline** only for one-off request bodies that are not reusable

```typescript
// Good: Import shared schemas
import {
  chapterAssignmentResponseSchema,
  createChapterAssignmentSchema,
} from './chapter-assignments.types';

// Acceptable: Inline for simple, non-reusable request bodies
const updateStatusRoute = createRoute({
  request: {
    body: jsonContent(
      z.object({ status: z.enum(['draft', 'complete']) }), // Simple, one-off
      'Status update'
    ),
  },
});
```

### Decision Matrix

| If the type is...                           | Put it in...         |
| ------------------------------------------- | -------------------- |
| A domain constant or enum used across files | `types.ts`           |
| Derived from a Drizzle schema               | `types.ts`           |
| Service function input/output               | `types.ts`           |
| An API response schema                      | `types.ts`           |
| A request schema used in multiple routes    | `types.ts`           |
| Specific to one repository query with joins | `repository.ts`      |
| Only needed for a single simple route       | Inline in `route.ts` |

## Repository Access Patterns

Services interact with data sources through repositories. The pattern differs based on whether you're accessing data within your domain or from another domain.

### Within the Same Domain

Import your domain's repository as a namespace and call functions directly:

```typescript
import * as repo from './chapter-assignments.repository';

export function getChapterAssignment(id: number) {
  return repo.findByIdWithOrg(id);
}

export async function createChapterAssignment(data: CreateChapterAssignmentData) {
  return db.transaction(async (tx) => {
    const assignment = await repo.insert(data, tx);
    await repo.insertStatusHistory(tx, assignment.id, status);
    return ok(assignment);
  });
}
```

**Guideline**: Always use namespace import (`import * as repo`) for consistency within the domain.

### Cross-Domain Access

**Never** access another domain's repository directly. Instead, call the other domain's service functions:

```typescript
// projects.service.ts
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';

export async function createProject(input: CreateProjectInput) {
  return db.transaction(async (tx) => {
    const project = await repo.insert(input, tx);

    // Delegate to chapter-assignments domain via its service
    const result = await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
      projectUnit.id,
      bibleId,
      bookId,
      tx // Pass transaction for consistency
    );

    // Here the error is err(ErrorCode.INTERNAL_ERROR) from the chapter-assignments service
    if (!result.ok) return result; // return the appropriate error code

    return ok(project);
  });
}
```

**Key principles for cross-domain calls:**

1. **Import the service, not the repository** — `import * as otherService from '@/domains/{domain}/{domain}.service'`
2. **Use public service functions** — Only call functions exported from the target domain's service file
3. **Pass transactions when needed** — For operations within the same transaction, pass the `tx` parameter
4. **Respect Result types** — Handle `Result<T>` returns from cross-domain calls appropriately

### Decision Matrix

| Scenario                                   | Access Pattern                                  | Example                          |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------- |
| Same domain, single repo                   | `import * as repo from './{domain}.repository'` | `repo.findById(id)`              |
| Same domain, multiple repos in same domain | Still use single repo import per file           | `repo.findX()` + `repo.findY()`  |
| Cross-domain read                          | Call other domain's service function            | `userService.getUserById(id)`    |
| Cross-domain write within transaction      | Call service function with `tx` param           | `otherService.updateX(data, tx)` |
| Complex cross-domain query                 | Service function wrapping repository logic      | `otherService.searchX(criteria)` |

### Anti-Patterns to Avoid

```typescript
// ❌ BAD: Direct repository access from another domain
import * as userRepo from '@/domains/users/users.repository';
// ✅ GOOD: Using the domain's public service API
import * as userService from '@/domains/users/users.service';

// ❌ BAD: Bypassing the service layer
const user = await userRepo.findById(userId);
const result = await userService.getUserById(userId);
```

**Why this matters:** Direct repository access couples domains at the persistence layer, making it impossible to change one domain's data model without breaking others. Services provide a stable public API.

## Testing Patterns

Tests focus on **service layer behavior** with mocked repositories. This isolates business logic from database dependencies and ensures fast, deterministic tests.

### Test Structure

```typescript
// src/domains/users/users.service.test.ts
import { describe, expect, it, vi } from 'vitest';

import * as repo from './users.repository';
import * as userService from './users.service';

// Mock the repository, not the database connection
vi.mock('./users.repository', () => ({
  findById: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

describe('createUser', () => {
  it('should create and return a new user', async () => {
    const mockUser = { id: 1, email: 'test@example.com' };
    vi.mocked(repo.insert).mockResolvedValue(mockUser);

    const result = await userService.createUser(input);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(mockUser);
    expect(repo.insert).toHaveBeenCalledWith(input);
  });

  it('should return error when email already exists', async () => {
    vi.mocked(repo.findByEmail).mockResolvedValue(existingUser);

    const result = await userService.createUser(input);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(ErrorCode.USER_ALREADY_EXISTS);
  });
});
```

### Testing Guidelines

| Do                                                            | Don't                                            |
| ------------------------------------------------------------- | ------------------------------------------------ |
| Mock the repository layer (`repo.insert`, `repo.findById`)    | Mock the database connection or Drizzle directly |
| Test both success and error paths using `Result<T>`           | Only test happy paths                            |
| Assert on `result.ok`, `result.data`, `result.error`          | Assert on thrown exceptions                      |
| Verify repository functions are called with correct arguments | Test implementation details like SQL queries     |
| Use `vi.mocked()` for type-safe mocks                         | Use `any` type casts for mocks                   |

### Cross-Domain Testing

When testing services that call other domains:

```typescript
import * as otherService from '@/domains/other/other.service';

vi.mock('@/domains/other/other.service', () => ({
  someFunction: vi.fn(),
}));

it('should delegate to other domain', async () => {
  vi.mocked(otherService.someFunction).mockResolvedValue(ok(mockData));
  // Test that your service calls otherService correctly
});
```

## Authorization and Middleware

Authorization follows a **Policy + Middleware** pattern that separates access rules from request handling.

### Pattern Overview

```
Route → Middleware (loads context + checks policy) → Handler
```

### Policy Layer (`{domain}.policy.ts`)

Policies are **pure functions** that evaluate access based on user context and resource state:

```typescript
// chapter-assignments.policy.ts
export const ChapterAssignmentPolicy = {
  edit(user: PolicyUser, assignment: PolicyAssignment): boolean {
    // Organization isolation check
    if (user.organization !== assignment.organizationId) {
      return false;
    }
    // Role-based logic
    if (user.roleName === ROLES.PROJECT_MANAGER) {
      return true;
    }
    // Resource ownership check
    return assignment.assignedUserId === user.id;
  },

  submit(user: PolicyUser, assignment: PolicyAssignment): boolean {
    // Different rules for different actions
    return (
      user.id === assignment.assignedUserId && assignment.status === CHAPTER_ASSIGNMENT_STATUS.DRAFT
    );
  },
};
```

**Policy Best Practices:**

- Keep policies **pure** — no side effects, no database calls
- Include **organization/tenant isolation** as the first check in every policy
- Accept only primitive values and simple objects, not full entities
- Return `boolean` — the middleware handles the HTTP response

### Middleware Layer (`{domain}.middleware.ts`)

Middleware loads resource context and applies policies:

```typescript
// chapter-assignment-auth.middleware.ts
export function requireChapterAssignmentAccess(action: ChapterAssignmentAction) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;
    const resourceId = Number(c.req.param('chapterAssignmentId'));

    // Load resource with auth context (includes org, membership, etc.)
    const result = await service.getWithAuthContext(resourceId, user.id, user.roleName);

    if (!result.ok) {
      return c.json({ message: result.error.message }, getHttpStatus(result.error));
    }

    const ctx = result.data;

    // Build policy inputs
    const policyUser = { id: user.id, roleName: user.roleName, organization: user.organization };
    const policyResource = {
      organizationId: ctx.organizationId,
      assignedUserId: ctx.assignedUserId,
    };

    // Evaluate policy
    const allowed = ChapterAssignmentPolicy[(policyUser, policyResource)];

    if (!allowed) {
      // Return 404 (not 403) to prevent resource enumeration
      return c.json({ message: 'Not found' }, HttpStatusCodes.NOT_FOUND);
    }

    // Attach resource to context for handler use
    c.set('chapterAssignment', ctx);
    return next();
  });
}
```

**Middleware Best Practices:**

- Load resource context once — avoid N+1 queries in route handlers
- Use **404 for authorization failures** (not 403) to prevent information leakage
- Attach loaded resource to Hono context so handlers don't re-fetch
- Keep policy evaluation logic minimal — delegate to policy functions

### Route Integration

```typescript
const updateRoute = createRoute({
  method: 'put',
  path: '/chapter-assignments/:chapterAssignmentId',
  middleware: [
    authenticateUser,
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.UPDATE),
  ] as const,
  handler: async (c) => {
    // Resource already loaded and authorized by middleware
    const assignment = c.get('chapterAssignment');
    // ... handle update
  },
});
```

### Decision Matrix

| Concern                                | Belongs In | Example                                            |
| -------------------------------------- | ---------- | -------------------------------------------------- |
| Can user X do action Y on resource Z?  | Policy     | `ChapterAssignmentPolicy.edit(user, assignment)`   |
| Load resource with auth context        | Service    | `service.getWithAuthContext(id, userId, roleName)` |
| Extract user from JWT, validate params | Middleware | `requireChapterAssignmentAccess(action)`           |
| HTTP response (401, 404, etc.)         | Middleware | `c.json({ message }, status)`                      |
| Tenant isolation check                 | Policy     | `user.organization === resource.organizationId`    |

## Adding a New Domain

When creating a new domain module:

1. Create a new folder under `src/domains/{domain-name}/`
2. Add the standard files: `types.ts`, `repository.ts`, `service.ts`, `route.ts`
3. Define domain types in `types.ts`
4. Implement data access in `repository.ts`
5. Add business logic in `service.ts`
6. Wire up routes in `route.ts`
7. Export routes from `app.ts`
