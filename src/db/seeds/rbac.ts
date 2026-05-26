import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { permissions, role_permissions, roles } from '@/db/schema';
import { PERMISSIONS } from '@/lib/permissions';
import { ROLES } from '@/lib/roles';

const PERMISSION_DEFINITIONS = [
  { name: PERMISSIONS.PROJECT_VIEW, description: 'View projects' },
  { name: PERMISSIONS.PROJECT_CREATE, description: 'Create new projects' },
  { name: PERMISSIONS.PROJECT_UPDATE, description: 'Update existing projects' },
  { name: PERMISSIONS.PROJECT_DELETE, description: 'Delete projects' },
  { name: PERMISSIONS.CONTENT_ASSIGN, description: 'Assign chapter assignment' },
  { name: PERMISSIONS.CONTENT_UPDATE, description: 'Update chapter assignment content' },
  { name: PERMISSIONS.USER_VIEW, description: 'View user profiles' },
  { name: PERMISSIONS.USER_CREATE, description: 'Create new users' },
  { name: PERMISSIONS.USER_UPDATE, description: 'Update user profiles' },
  { name: PERMISSIONS.USER_DELETE, description: 'Delete user' },
];

const ROLE_PERMISSION_MAP = [
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_VIEW },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_CREATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_UPDATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_DELETE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.CONTENT_ASSIGN },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.CONTENT_UPDATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.USER_VIEW },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.USER_CREATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.USER_UPDATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.USER_DELETE },
  { roleName: ROLES.TRANSLATOR, permissionName: PERMISSIONS.PROJECT_VIEW },
  { roleName: ROLES.TRANSLATOR, permissionName: PERMISSIONS.CONTENT_UPDATE },
  { roleName: ROLES.TRANSLATOR, permissionName: PERMISSIONS.USER_VIEW },
  { roleName: ROLES.TRANSLATOR, permissionName: PERMISSIONS.USER_UPDATE },
];

export async function seedRbac() {
  await db
    .insert(permissions)
    .values(PERMISSION_DEFINITIONS)
    .onConflictDoNothing({ target: permissions.name });

  const allRoles = await db.select({ id: roles.id, name: roles.name }).from(roles);
  const allPermissions = await db
    .select({ id: permissions.id, name: permissions.name })
    .from(permissions);

  const roleMap = new Map(allRoles.map((r) => [r.name, r.id]));
  const permissionMap = new Map(allPermissions.map((p) => [p.name, p.id]));

  const rolePermissionRows = ROLE_PERMISSION_MAP.map(({ roleName, permissionName }) => {
    const roleId = roleMap.get(roleName);
    const permissionId = permissionMap.get(permissionName);

    if (!roleId) throw new Error(`Role not found in DB: ${roleName}`);
    if (!permissionId) throw new Error(`Permission not found in DB: ${permissionName}`);

    return { roleId, permissionId };
  });

  await db.insert(role_permissions).values(rolePermissionRows).onConflictDoNothing();
  console.log('RBAC seeded.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedRbac()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
