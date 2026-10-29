import type { DemoSpec, DemoUser } from './types';

// `createdBy` should name the realistic creating actor: the org's Org Manager
// where one exists, else the global user (SuperAdmin), else the first spec
// user. Users created *before* their actor exists get null (self/first).

export function orgManagerKey(spec: DemoSpec, orgKey: string): string | undefined {
  return spec.users.find((u) =>
    u.orgs?.some((o) => o.org === orgKey && o.roles.includes('Org Manager'))
  )?.key;
}

export function globalActorKey(spec: DemoSpec): string | undefined {
  return spec.users.find((u) => u.globalRoles?.length)?.key;
}

export function actorKeyFor(spec: DemoSpec, user: DemoUser): string | null {
  const firstOrg = user.orgs?.[0]?.org;
  const candidates = [
    firstOrg ? orgManagerKey(spec, firstOrg) : undefined,
    globalActorKey(spec),
    spec.users[0]?.key,
  ];
  // A user can't be their own creator — fall through to the next candidate.
  return candidates.find((key): key is string => key !== undefined && key !== user.key) ?? null;
}

/** Seed order: global actors first, then org managers, then everyone else —
 *  so every user's `createdBy` target already exists when they are written. */
export function orderedUsers(spec: DemoSpec): DemoUser[] {
  const isGlobal = (u: DemoUser) => (u.globalRoles?.length ?? 0) > 0;
  const isOrgManager = (u: DemoUser) =>
    u.orgs?.some((o) => o.roles.includes('Org Manager')) ?? false;
  return [
    ...spec.users.filter(isGlobal),
    ...spec.users.filter((u) => !isGlobal(u) && isOrgManager(u)),
    ...spec.users.filter((u) => !isGlobal(u) && !isOrgManager(u)),
  ];
}
