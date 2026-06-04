export const ROLES = {
  SUPER_ADMIN: 'SuperAdmin',
  ORG_OWNER: 'Org Owner',
  ORG_MANAGER: 'Org Manager',
  PROJECT_MANAGER: 'Project Manager',
  PROJECT_TRANSLATOR: 'Project Translator',
  PROJECT_OBSERVER: 'Project Observer',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];
