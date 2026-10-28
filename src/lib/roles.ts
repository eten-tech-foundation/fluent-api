export const ROLES = {
  SUPER_ADMIN: 'SuperAdmin',
  ORG_MANAGER: 'Org Manager',
  ORG_MEMBER: 'Org Member',
  PROJECT_MANAGER: 'Project Manager',
  PROJECT_TRANSLATOR: 'Project Translator',
  PROJECT_OBSERVER: 'Project Observer',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

// The roles carried by project-scoped grants (user_roles.projectId set).
export const PROJECT_ROLES = [
  ROLES.PROJECT_MANAGER,
  ROLES.PROJECT_TRANSLATOR,
  ROLES.PROJECT_OBSERVER,
] as const satisfies readonly RoleName[];

export type ProjectRole = (typeof PROJECT_ROLES)[number];

export function isProjectRole(name: string): name is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(name);
}
