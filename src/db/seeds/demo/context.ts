import { db } from '@/db';
import { roles } from '@/db/schema';

import type { GrantPlan } from './grants';
import type { DemoSpec } from './types';

import { buildGrantPlan } from './grants';

/** Key→id resolution state shared by every `seedDemoSpec` stage. */
export interface DemoCtx {
  spec: DemoSpec;
  /** Desired grants, built once — user/org/project keys, resolved to ids per stage. */
  grantPlan: GrantPlan[];
  orgs: Map<string, number>; // org key → organizations.id
  users: Map<string, number>; // user key → users.id
  projects: Map<string, number>; // project key → projects.id
  milestones: Map<string, number>; // `${projectKey}/${milestoneKey}` → project_units.id
  languages: Map<string, number>; // iso639-3 → languages.id
  bibles: Map<string, number>; // abbreviation → bibles.id
  books: Map<string, number>; // code → books.id
  pericopeSets: Map<string, number>; // name → pericope_sets.id
  roles: Map<string, number>; // name → roles.id
}

/** Loads role ids (grant resolution) and builds the desired-grant plan. */
export async function buildDemoCtx(spec: DemoSpec): Promise<DemoCtx> {
  const allRoles = await db.select({ id: roles.id, name: roles.name }).from(roles);
  return {
    spec,
    grantPlan: buildGrantPlan(spec),
    orgs: new Map(),
    users: new Map(),
    projects: new Map(),
    milestones: new Map(),
    languages: new Map(),
    bibles: new Map(),
    books: new Map(),
    pericopeSets: new Map(),
    roles: new Map(allRoles.map((r) => [r.name, r.id])),
  };
}
