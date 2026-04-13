import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { ChapterAssignmentPolicy } from '@/domains/chapter-assignments/chapter-assignments.policy';
import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { UserPolicy } from '@/domains/users/user.policy';
import * as userService from '@/domains/users/users.service';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as usersChapterAssignmentsService from './users-chapter-assignments.service';
import { userChapterAssignmentsByUserResponseSchema } from './users-chapter-assignments.types';

const getChapterAssignmentsByUserIdRoute = createRoute({
  tags: ['Users - Chapter Assignments'],
  method: 'get',
  path: '/users/{userId}/chapter-assignments',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.USER_VIEW)] as const,
  request: {
    params: z.object({
      userId: z.coerce.number().int().positive(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userChapterAssignmentsByUserResponseSchema.openapi('ChapterAssignmentsByUser'),
      'Chapter assignments for the user separated by role'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Access denied'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'User not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get chapter assignments by user ID',
  description: 'Returns all chapter assignments for a user. Translators can only fetch their own.',
});

server.openapi(getChapterAssignmentsByUserIdRoute, async (c) => {
  const { userId } = c.req.valid('param');
  const currentUser = c.get('user')!;
  const policyUser = {
    id: currentUser.id,
    roleName: currentUser.roleName,
    organization: currentUser.organization,
  };

  const targetUserResult = await userService.getUserById(userId);
  if (!targetUserResult.ok) {
    return c.json({ message: 'User not found' }, HttpStatusCodes.NOT_FOUND);
  }

  if (!UserPolicy.view(policyUser, targetUserResult.data)) {
    return c.json({ message: 'User not found' }, HttpStatusCodes.NOT_FOUND);
  }

  const result = await usersChapterAssignmentsService.getAllChapterAssignmentsByUserId(userId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const assignUsersToChaptersRoute = createRoute({
  tags: ['Users - Chapter Assignments'],
  method: 'patch',
  path: '/users/{userId}/chapter-assignments',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_ASSIGN)] as const,
  request: {
    params: z.object({
      userId: z.preprocess(
        (val) => (val === 'null' ? null : val),
        z.coerce.number().int().positive().nullable()
      ),
    }),
    body: jsonContent(
      z.object({
        chapterAssignmentIds: z
          .array(z.number().int())
          .min(1, 'At least one chapter assignment ID is required'),
        peerCheckerId: z.number().int().nullable(),
      }),
      'Add chapter assignment IDs and peer checker ID'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(z.number().int()).openapi('UserChapterAssignments'),
      'Successfully assigned user to chapters'
    ),
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
      'Manager access required'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'User or chapter assignments not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Assign user to specific chapters',
  description: 'Assigns a user to specific chapter assignments. Manager only.',
});

server.openapi(assignUsersToChaptersRoute, async (c) => {
  const assignedUserId = c.req.valid('param').userId; // now number | null
  const assignmentData = c.req.valid('json'); // peerCheckerId: number | null
  const currentUser = c.get('user')!;
  const policyUser = {
    id: currentUser.id,
    roleName: currentUser.roleName,
    organization: currentUser.organization,
  };

  // Guard: only look up user if assignedUserId is non-null
  if (assignedUserId !== null) {
    const targetUserResult = await userService.getUserById(assignedUserId);
    if (!targetUserResult.ok || !UserPolicy.view(policyUser, targetUserResult.data)) {
      return c.json({ message: 'User not found' }, HttpStatusCodes.NOT_FOUND);
    }
  }

  const firstAssignmentResult = await chapterAssignmentService.getChapterAssignment(
    assignmentData.chapterAssignmentIds[0]
  );
  if (!firstAssignmentResult.ok) {
    return c.json({ message: 'Chapter assignment not found' }, HttpStatusCodes.NOT_FOUND);
  }

  if (!ChapterAssignmentPolicy.assignDrafter(policyUser, firstAssignmentResult.data)) {
    return c.json({ message: 'Forbidden: Insufficient permissions' }, HttpStatusCodes.FORBIDDEN);
  }

  const result = await usersChapterAssignmentsService.assignUserToChapters(
    assignedUserId, // now passes null through
    assignmentData.chapterAssignmentIds,
    assignmentData.peerCheckerId // now passes null through
  );

  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
