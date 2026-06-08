import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { ChapterAssignmentPolicy } from '@/domains/chapter-assignments/chapter-assignments.policy';
import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as service from './project-chapter-assignments.service';
import {
  assignSelectedRequestSchema,
  assignSelectedResponseSchema,
  assignUserInputSchema,
  chapterAssignmentProgressResponseSchema,
  chapterAssignmentResponseSchema,
} from './project-chapter-assignments.types';

const projectIdParam = z.object({ projectId: z.coerce.number().int().positive() });

// ─── GET /projects/:projectId/chapter-assignments ─────────────────────────────

const getProjectChapterAssignmentsRoute = createRoute({
  tags: ['Projects - Chapter Assignments'],
  method: 'get',
  path: '/projects/{projectId}/chapter-assignments',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Get project chapter assignments',
  description: 'Returns a list of chapter assignments for the project.',
  request: { params: projectIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(chapterAssignmentResponseSchema.array(), 'Assignments list'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Project access required'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not found'),
      'Project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(getProjectChapterAssignmentsRoute, async (c) => {
  const { projectId } = c.req.valid('param');

  const result = await service.getProjectChapterAssignments(projectId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── DELETE /projects/:projectId/chapter-assignments ─────────────────────────

const deleteProjectChapterAssignmentsRoute = createRoute({
  tags: ['Projects - Chapter Assignments'],
  method: 'delete',
  path: '/projects/{projectId}/chapter-assignments',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_ASSIGN),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Delete all chapter assignments for a project',
  description: 'Deletes all chapter assignments associated with a specific project. Manager only.',
  request: { params: projectIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ deletedCount: z.number().int() }), 'Success'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Manager access required'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not found'),
      'Project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(deleteProjectChapterAssignmentsRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const currentUser = c.get('user')!;
  const project = c.get('project')!;
  const policyUser = {
    id: currentUser.id,
    roleName: currentUser.roleName,
    organization: currentUser.organization,
  };

  if (!ChapterAssignmentPolicy.deleteAll(policyUser, project.organization)) {
    return c.json({ message: 'Forbidden' }, HttpStatusCodes.FORBIDDEN);
  }

  const result = await service.deleteChapterAssignmentsByProject(projectId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /projects/:projectId/chapter-assignments/progress ───────────────────

const getChapterAssignmentProgressRoute = createRoute({
  tags: ['Projects - Chapter Assignments'],
  method: 'get',
  path: '/projects/{projectId}/chapter-assignments/progress',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Get chapter assignment progress',
  description: 'Returns chapter assignments with progress completion statistics for a project.',
  request: { params: projectIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(chapterAssignmentProgressResponseSchema.array(), 'Progress'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Project access required'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not found'),
      'Project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(getChapterAssignmentProgressRoute, async (c) => {
  const { projectId } = c.req.valid('param');

  const result = await service.getChapterAssignmentProgressByProject(projectId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /projects/:projectId/chapter-assignments/assign-all ───────────────

const assignAllRoute = createRoute({
  tags: ['Projects - Chapter Assignments'],
  method: 'patch',
  path: '/projects/{projectId}/chapter-assignments/assign-all',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_ASSIGN),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Assign users to all chapters for a project',
  description:
    'Assigns a drafter and/or peer checker to all chapter assignments for a project. Manager only.',
  request: {
    params: projectIdParam,
    body: jsonContent(assignUserInputSchema, 'User IDs to assign'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(chapterAssignmentResponseSchema.array(), 'Success'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Assigned user is not in the project organisation'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Manager access required'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not found'),
      'Project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(assignAllRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const assignmentData = c.req.valid('json');
  const currentUser = c.get('user')!;
  const project = c.get('project')!;
  const policyUser = {
    id: currentUser.id,
    roleName: currentUser.roleName,
    organization: currentUser.organization,
  };

  if (!ChapterAssignmentPolicy.assignAll(policyUser, project.organization)) {
    return c.json({ message: 'Forbidden' }, HttpStatusCodes.FORBIDDEN);
  }

  const result = await service.assignAllProjectChapterAssignmentsToUser(projectId, assignmentData);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /projects/:projectId/chapter-assignments/assign-selected ───────────

const assignSelectedRoute = createRoute({
  tags: ['Projects - Chapter Assignments'],
  method: 'patch',
  path: '/projects/{projectId}/chapter-assignments/assign-selected',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_ASSIGN),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Assign selected chapter assignments',
  description:
    'Assigns individual drafters and peer checkers to specific chapter assignments within a ' +
    'project. All chapter assignment IDs must belong to the given project. All user IDs must ' +
    'belong to the project organization. A user cannot be both drafter and peer checker on the ' +
    'same assignment. Pass null to unassign a role. Manager only.',
  request: {
    params: projectIdParam,
    body: jsonContent(
      assignSelectedRequestSchema,
      'Per-assignment drafter and peer-checker assignments'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(assignSelectedResponseSchema, 'Success'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid request data'
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
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Project, chapter assignment, or user not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(assignSelectedRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const { assignments } = c.req.valid('json');
  const currentUser = c.get('user')!;
  const project = c.get('project')!;

  const policyUser = {
    id: currentUser.id,
    roleName: currentUser.roleName,
    organization: currentUser.organization,
  };

  if (!ChapterAssignmentPolicy.assignAll(policyUser, project.organization)) {
    return c.json({ message: 'Forbidden' }, HttpStatusCodes.FORBIDDEN);
  }

  const result = await service.assignSelectedChapters(projectId, assignments);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
