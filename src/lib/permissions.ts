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

  // ── AI tools ────────────────────────────────────────────────────────
  // Intentional alias of CONTENT_UPDATE (same string value) so "can invoke
  // AI tools" is documented separately at call sites without yet being a
  // distinct RBAC row. Promoting it to a real permission later means adding a
  // `permissions` row, mapping it to roles in seed data, and changing only the
  // string value here — no call site that imports AI_TOOLS_USE needs to change.
  // Decision D10 / §9.3. Approved in review:
  // https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343633722
  AI_TOOLS_USE: 'content:update',

  // ── Source TTS ──────────────────────────────────────────────────────
  // "Can have the source text read aloud." Follows the AI_TOOLS_USE pattern
  // above (an intentional alias, documented at call sites, not yet its own RBAC
  // row) but deliberately aliases PROJECT_VIEW, not CONTENT_UPDATE: listening to
  // the SOURCE text reveals nothing the user cannot already read on screen, so
  // hearing follows seeing. Gating it on content:update would wrongly deny a
  // reviewer or observer who can legitimately view the passage.
  //
  // Proposal decision T13 / §11.1. NOTE: unlike AI_TOOLS_USE this alias has not
  // yet been confirmed in review — if a reviewer wants TTS restricted to users
  // who can edit, change the value here to 'content:update' and no call site
  // that imports TTS_USE needs to change.
  TTS_USE: 'project:view',

  // ── Users ───────────────────────────────────────────────────────────
  USER_VIEW: 'user:view',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const VALID_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS));

export function isPermission(value: string): value is Permission {
  return VALID_PERMISSIONS.has(value);
}
