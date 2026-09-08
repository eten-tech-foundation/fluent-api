import { createRoute, z } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import type { ProjectAction } from '@/domains/projects/projects.types';
import type { AppEnv } from '@/server/context.types';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as milestonesService from './milestones.service';
import {
  createMilestoneSchema,
  milestoneResponseSchema,
  updateMilestoneSchema,
} from './milestones.types';

const projectIdParam = z.object({
  projectId: z.coerce
    .number()
    .openapi({ param: { name: 'projectId', in: 'path', required: true } }),
});

const milestoneIdParam = z.object({
  id: z.coerce.number().openapi({ param: { name: 'id', in: 'path', required: true } }),
});

const requireMilestoneAccess = (action: ProjectAction) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;
    const policyUser = { id: user.id, grants: user.grants };
    const id = Number(c.req.param('id'));

    const milestoneRes = await milestonesService.getMilestone(id);
    if (!milestoneRes.ok)
      return c.json({ message: 'Milestone not found' }, HttpStatusCodes.NOT_FOUND);

    const projectId = milestoneRes.data.projectId;
    const projectRes = await projectService.getProjectById(projectId);
    if (!projectRes.ok) return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);

    const project = projectRes.data;
    let allowed = false;

    switch (action) {
      case PROJECT_ACTIONS.READ: {
        const isProjectMember = await resolveIsProjectMember(projectId, user.id);
        allowed = ProjectPolicy.read(policyUser, project, isProjectMember);
        break;
      }
      case PROJECT_ACTIONS.UPDATE:
        allowed = ProjectPolicy.update(policyUser, project);
        break;
      case PROJECT_ACTIONS.DELETE:
        allowed = ProjectPolicy.delete(policyUser, project);
        break;
    }

    if (!allowed) {
      return c.json({ message: 'Milestone not found' }, HttpStatusCodes.NOT_FOUND);
    }

    return next();
  });

// ─── POST /projects/:projectId/milestones ──────────────────────────────────────

const createMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'post',
  path: '/projects/{projectId}/milestones',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Create a milestone for a project',
  request: {
    params: projectIdParam,
    body: jsonContentRequired(createMilestoneSchema, 'Milestone to create'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(milestoneResponseSchema, 'Created milestone'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'Constraint violation'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(createMilestoneRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const input = c.req.valid('json');

  const result = await milestonesService.createMilestone(projectId, input);
  if (result.ok) return c.json(result.data as any, HttpStatusCodes.CREATED);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /projects/:projectId/milestones ───────────────────────────────────────

const listMilestonesRoute = createRoute({
  tags: ['Milestones'],
  method: 'get',
  path: '/projects/{projectId}/milestones',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'List milestones for a project',
  request: { params: projectIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(milestoneResponseSchema), 'List of milestones'),
  },
});

server.openapi(listMilestonesRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const result = await milestonesService.getMilestones(projectId);
  if (result.ok) return c.json(result.data as any, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /milestones/:id ───────────────────────────────────────────────────────

const getMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'get',
  path: '/milestones/{id}',
  middleware: [authenticateUser, requireMilestoneAccess(PROJECT_ACTIONS.READ)] as const,
  summary: 'Get a milestone',
  request: { params: milestoneIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(milestoneResponseSchema, 'Milestone'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Milestone not found'
    ),
  },
});

server.openapi(getMilestoneRoute, async (c) => {
  const { id } = c.req.valid('param');
  const result = await milestonesService.getMilestone(id);
  if (result.ok) return c.json(result.data as any, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /milestones/:id ─────────────────────────────────────────────────────

const updateMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'patch',
  path: '/milestones/{id}',
  middleware: [authenticateUser, requireMilestoneAccess(PROJECT_ACTIONS.UPDATE)] as const,
  summary: 'Update a milestone',
  request: {
    params: milestoneIdParam,
    body: jsonContentRequired(updateMilestoneSchema, 'Updates'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(milestoneResponseSchema, 'Updated milestone'),
  },
});

server.openapi(updateMilestoneRoute, async (c) => {
  const { id } = c.req.valid('param');
  const updates = c.req.valid('json');

  const result = await milestonesService.updateMilestone(id, updates);
  if (result.ok) return c.json(result.data as any, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── DELETE /milestones/:id ────────────────────────────────────────────────────

const deleteMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'delete',
  path: '/milestones/{id}',
  middleware: [authenticateUser, requireMilestoneAccess(PROJECT_ACTIONS.DELETE)] as const,
  summary: 'Delete a milestone',
  request: { params: milestoneIdParam },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: 'Deleted' },
  },
});

server.openapi(deleteMilestoneRoute, async (c) => {
  const { id } = c.req.valid('param');
  const result = await milestonesService.deleteMilestone(id);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
