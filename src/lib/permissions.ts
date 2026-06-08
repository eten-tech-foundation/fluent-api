/**
 * Every permission string used in the system.
 * These match the `permissions.name` column values seeded into the DB.
 *
 * Used in two places:
 *   1. requirePermission(PERMISSIONS.X) in route middleware
 *      → coarse gate: does this role have this permission at all?
 *
 *   2. seed file
 *      → inserting the permission rows into the DB
 *
 * Constraints (self_only, assigned_only, post_peer_check) are NOT stored here
 * or in the DB. They are evaluated as code in Policy files per resource.
 *
 */
export const PERMISSIONS = {
  // ── Projects ────────────────────────────────────────────────────────
  PROJECT_VIEW: 'project:view',
  PROJECT_CREATE: 'project:create',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',

  // ── Content ─────────────────────────────────────────────────────────
  CONTENT_ASSIGN: 'content:assign',
  CONTENT_UPDATE: 'content:update',

  // ── AI tools ────────────────────────────────────────────────────────
  // Intentional alias of CONTENT_UPDATE (same string value) so "can invoke
  // AI tools" is documented separately at call sites without yet being a
  // distinct RBAC row. Promoting it to a real permission later means adding a
  // `permissions` row, mapping it to roles in seed data, and changing only the
  // string value here — no call site that imports AI_TOOLS_USE needs to change.
  // Decision D10 / §9.3. Approved in review:
  // https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343633722
  AI_TOOLS_USE: 'content:update',

  // ── Users ───────────────────────────────────────────────────────────
  USER_VIEW: 'user:view',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
