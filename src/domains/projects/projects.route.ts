import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { db } from '@/db';
import { organizations, user_roles } from '@/db/schema';
import { getRoleId, grantRole } from '@/domains/user-roles/user-roles.service';
import { ZOD_ERROR_MESSAGES } from '@/lib/constants';
import { PERMISSIONS } from '@/lib/permissions';
import { ROLES } from '@/lib/roles';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, orgFromBody, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireProjectAccess } from './project-auth.middleware';
import * as projectService from './projects.service';
import {
  createProjectWithUnitsSchema,
  PROJECT_ACTIONS,
  projectResponseSchema,
  projectWithLanguageNamesSchema,
  updateProjectWithUnitsSchema,
} from './projects.types';

const idParam = z.object({
  id: z.coerce.number().openapi({ param: { name: 'id', in: 'path', required: true } }),
});

// ─── GET /projects ────────────────────────────────────────────────────────────

const listProjectsRoute = createRoute({
  tags: ['Projects'],
  method: 'get',
  path: '/projects',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.LIST),
  ] as const,
  summary: 'Get all projects',
  description: 'Project Managers: all projects in their organisation.',
  responses: {
    [HttpStatusCodes.OK]: jsonContent(projectWithLanguageNamesSchema.array(), 'List of projects'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(listProjectsRoute, async (c) => {
  const currentUser = c.get('user')!;
  const activeOrgId = c.get('activeOrgId');

  const grants =
    activeOrgId !== null && activeOrgId !== undefined
      ? currentUser.grants.filter((g) => g.orgId === activeOrgId || g.orgId === null)
      : currentUser.grants;

  const result = await projectService.getProjectsForUser({
    id: currentUser.id,
    grants,
  });
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /projects ───────────────────────────────────────────────────────────

const createProjectRoute = createRoute({
  tags: ['Projects'],
  method: 'post',
  path: '/projects',
  middleware: [
    authenticateUser,
    // Solo-workflow: users with zero orgs are allowed through without a PROJECT_CREATE grant.
    // The handler detects this and provisions a personal org before creating the project.
    // Users who already belong to an org must still have PROJECT_CREATE scoped to that org.
    //
    // TEMP: Project Managers are project-pinned (orgId+projectId) so the normal org-level
    // authorize() check (which requires projectId=null) would deny them. Until the proper
    // Org Manager workflow is in place, we also accept any grant that carries PROJECT_CREATE
    // within the matching org regardless of projectId. Remove this bypass once the upcoming
    // org-manager task is merged and QA has full org-manager accounts.
    async (c: any, next: any) => {
      const user = c.get('user');
      const hasAnyOrg = user?.grants?.some((g: any) => g.orgId !== null);
      if (!hasAnyOrg) return next(); // zero-org solo path — skip permission gate

      // TEMP: also allow project-pinned grants (e.g. Project Manager) that carry PROJECT_CREATE
      // within the org specified in the request body.
      const body = await c.req.raw
        .clone()
        .json()
        .catch(() => ({}));
      const orgId = Number(body?.orgId ?? body?.organization);
      if (Number.isFinite(orgId)) {
        const hasCreateInOrg = user?.grants?.some(
          (g: any) => g.orgId === orgId && g.permissions?.has(PERMISSIONS.PROJECT_CREATE)
        );
        if (hasCreateInOrg) return next();
      }

      return requirePermission(PERMISSIONS.PROJECT_CREATE, orgFromBody)(c, next);
    },
  ] as const,
  summary: 'Create a new project',
  description:
    'Creates a project. If the caller has no org yet, provisions a personal org automatically (solo workflow).',
  request: { body: jsonContentRequired(createProjectWithUnitsSchema, 'Project to create') },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(projectResponseSchema, 'Created project'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'Constraint violation'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(createProjectRoute, async (c) => {
  const projectData = c.req.valid('json');
  const currentUser = c.get('user')!;

  let pmRoleId: number;
  try {
    pmRoleId = await getRoleId(ROLES.PROJECT_MANAGER);
  } catch {
    return c.json(
      { message: 'Internal Server Error: Missing PM role definition' },
      HttpStatusCodes.INTERNAL_SERVER_ERROR as never
    );
  }

  // ── Solo-workflow extension point ───────────────────────────────
  // If the caller has no existing org, provision a personal org and grant
  // Org Manager + Org Member anchor row before continuing.
  let resolvedOrgId: number | undefined = projectData.organization;
  const hasAnyOrg = currentUser.grants.some((g) => g.orgId !== null);

  if (!hasAnyOrg) {
    // Zero-org solo path: ignore caller-supplied org ID and force personal org provisioning
    resolvedOrgId = undefined;
  }

  if (!resolvedOrgId) {
    if (hasAnyOrg) {
      // User has orgs but didn't specify one — require it.
      return c.json(
        { message: 'organization is required when the caller belongs to one or more orgs.' },
        HttpStatusCodes.BAD_REQUEST as never
      );
    }

    // Zero-org path: provision a personal org atomically.
    try {
      const orgName = `${currentUser.email}'s Organization`;

      await db.transaction(async (tx) => {
        const [newOrg] = await tx
          .insert(organizations)
          .values({ name: orgName })
          .returning({ id: organizations.id });

        resolvedOrgId = newOrg.id;

        const orgMemberRoleId = await getRoleId(ROLES.ORG_MEMBER);
        const orgManagerRoleId = await getRoleId(ROLES.ORG_MANAGER);

        // Anchor row (Org Member) + Org Manager grant
        await tx
          .insert(user_roles)
          .values({
            userId: currentUser.id,
            orgId: resolvedOrgId,
            projectId: null,
            roleId: orgMemberRoleId,
            createdBy: currentUser.id,
          })
          .onConflictDoNothing();

        await tx
          .insert(user_roles)
          .values({
            userId: currentUser.id,
            orgId: resolvedOrgId,
            projectId: null,
            roleId: orgManagerRoleId,
            createdBy: currentUser.id,
          })
          .onConflictDoNothing();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to provision personal org';
      return c.json({ message }, HttpStatusCodes.INTERNAL_SERVER_ERROR as never);
    }
  }

  if (!resolvedOrgId) {
    return c.json(
      { message: 'Failed to resolve organization' },
      HttpStatusCodes.INTERNAL_SERVER_ERROR as never
    );
  }
  // ──────────────────────────────────────────────────────────────────

  const result = await projectService.createProject({
    ...projectData,
    createdBy: currentUser.id,
    organization: resolvedOrgId,
  });

  if (result.ok) {
    const grantResult = await grantRole({
      userId: currentUser.id,
      orgId: resolvedOrgId,
      projectId: result.data.id,
      roleId: pmRoleId,
      createdBy: currentUser.id,
    });
    if (!grantResult.ok) {
      const deleteResult = await projectService.deleteProject(result.data.id);
      const message = deleteResult.ok
        ? 'Project created but failed to assign creator role. Rolled back.'
        : `Project created but failed to assign creator role, and rollback failed: ${deleteResult.error.message}`;
      return c.json({ message }, HttpStatusCodes.INTERNAL_SERVER_ERROR as never);
    }
    return c.json(result.data, HttpStatusCodes.CREATED);
  }
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /projects/:id ────────────────────────────────────────────────────────

const getProjectRoute = createRoute({
  tags: ['Projects'],
  method: 'get',
  path: '/projects/{id}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ),
  ] as const,
  summary: 'Get a project by ID',
  request: { params: idParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(projectWithLanguageNamesSchema, 'The project'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(getProjectRoute, async (c) => {
  const project = c.get('project')!;
  return c.json(project, HttpStatusCodes.OK);
});

// ─── PATCH /projects/:id ──────────────────────────────────────────────────────

const updateProjectRoute = createRoute({
  tags: ['Projects'],
  method: 'patch',
  path: '/projects/{id}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE),
  ] as const,
  summary: 'Update a project',
  description: 'Project Manager only.',
  request: {
    params: idParam,
    body: jsonContentRequired(updateProjectWithUnitsSchema, 'Project updates'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(projectResponseSchema, 'Updated project'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'Constraint violation'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Project not found'
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema('Unprocessable Entity'),
      'No updates provided'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(updateProjectRoute, async (c) => {
  const { id } = c.req.valid('param');
  const updates = c.req.valid('json');

  if (Object.keys(updates).length === 0) {
    return c.json({ message: ZOD_ERROR_MESSAGES.NO_UPDATES }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }

  const result = await projectService.updateProject(id, updates);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── DELETE /projects/:id ─────────────────────────────────────────────────────

const deleteProjectRoute = createRoute({
  tags: ['Projects'],
  method: 'delete',
  path: '/projects/{id}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_DELETE),
    requireProjectAccess(PROJECT_ACTIONS.DELETE),
  ] as const,
  summary: 'Delete a project',
  description: 'Project Manager only.',
  request: { params: idParam },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: 'Project deleted' },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(deleteProjectRoute, async (c) => {
  const { id } = c.req.valid('param');

  const result = await projectService.deleteProject(id);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
