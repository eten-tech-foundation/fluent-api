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
  CONTENT_VIEW: 'content:view',
  CONTENT_ASSIGN: 'content:assign',
  CONTENT_UPDATE: 'content:update',

  // ── Membership / role assignment ────────────────────────────────────
  MEMBERSHIP_REVOKE: 'membership:revoke',
  ROLE_ASSIGN_PROJECT: 'role:assign:project',
  ROLE_ASSIGN_ORG_MANAGER: 'role:assign:org_manager',

  // ── Users ───────────────────────────────────────────────────────────
  USER_VIEW: 'user:view',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
