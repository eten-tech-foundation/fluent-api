import { z } from '@hono/zod-openapi';

import { ROLES } from '@/lib/roles';

// Org-level roles only (D1): project-scoped roles are managed on the project.
// Org Member = demotion — removes the org-level role but keeps membership.
export const updateOrgUserRoleBodySchema = z.object({
  roleName: z.enum([ROLES.ORG_MANAGER, ROLES.ORG_MEMBER]),
});

export type UpdateOrgUserRoleBody = z.infer<typeof updateOrgUserRoleBodySchema>;
