import type { DemoSpec } from './types';

/**
 * A desired `user_roles` row expressed in spec keys — resolved to ids by the
 * engine. `orgKey`/`projectKey` nulls mirror the DB columns: org-scoped grants
 * carry org only, global grants carry neither, project-scoped carry both.
 */
export interface GrantPlan {
  userKey: string;
  roleName: string;
  orgKey: string | null;
  projectKey: string | null;
}

/** Role names that are only ever valid at project scope. */
export const PROJECT_SCOPED_ROLE_NAMES = new Set([
  'Project Manager',
  'Project Translator',
  'Project Observer',
]);

/**
 * Expands a spec's users into the full set of desired grant rows, matching the
 * app's real RBAC scoping:
 * - `Org Member` anchor is implicit per org membership (deduped if declared).
 * - `Org Manager` → org-scoped (projectKey null).
 * - Project roles → project-scoped, and the grant's org is the *project's*
 *   org — which may differ from the user's membership orgs (cross-org grants).
 * - `SuperAdmin` → a single global grant (both keys null).
 */
export function buildGrantPlan(spec: DemoSpec): GrantPlan[] {
  const projectOrg = new Map(spec.projects.map((p) => [p.key, p.org]));
  const plan: GrantPlan[] = [];

  for (const user of spec.users) {
    const seen = new Set<string>();
    const push = (roleName: string, orgKey: string | null, projectKey: string | null) => {
      const sig = `${roleName}|${orgKey}|${projectKey}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        plan.push({ userKey: user.key, roleName, orgKey, projectKey });
      }
    };

    for (const orgEntry of user.orgs ?? []) {
      push('Org Member', orgEntry.org, null);
      for (const role of orgEntry.roles) {
        push(role, orgEntry.org, null);
      }
    }
    for (const pr of user.projectRoles ?? []) {
      const org = projectOrg.get(pr.project);
      if (!org) {
        throw new Error(`User "${user.key}" has a role on unknown project "${pr.project}"`);
      }
      push(pr.role, org, pr.project);
    }
    for (const role of user.globalRoles ?? []) {
      push(role, null, null);
    }
  }

  return plan;
}

/**
 * True for a grant row a seed must delete on reconcile: a project-scoped role
 * (`projectId IS NULL`) never correctly models PM/Translator/Observer access —
 * it's residue of the old seed pattern or a manual mistake. Only apply to
 * rows belonging to spec-managed users.
 */
export function isStaleProjectRoleGrant(grant: {
  roleName: string;
  projectKey: string | null;
}): boolean {
  return PROJECT_SCOPED_ROLE_NAMES.has(grant.roleName) && grant.projectKey === null;
}
