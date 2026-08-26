import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { Result } from '@/lib/types';
import type { AppEnv } from '@/server/context.types';

import { getHttpStatus } from '@/lib/types';

import type { ChapterAssignmentWithAuthContext } from './chapter-assignments.repository';
import type { ChapterAssignmentAction } from './chapter-assignments.types';

import { ChapterAssignmentPolicy } from './chapter-assignments.policy';
import * as chapterAssignmentService from './chapter-assignments.service';
import { CHAPTER_ASSIGNMENT_ACTIONS } from './chapter-assignments.types';

// Loads a chapter assignment with auth context and evaluates the policy.
export function requireChapterAssignmentAccess(
  action: ChapterAssignmentAction,
  paramName = 'chapterAssignmentId'
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;

    const chapterAssignmentId = Number(c.req.param(paramName));
    if (!chapterAssignmentId || Number.isNaN(chapterAssignmentId)) {
      return c.json({ message: 'Missing chapter assignment ID' }, HttpStatusCodes.BAD_REQUEST);
    }

    const result: Result<ChapterAssignmentWithAuthContext> =
      await chapterAssignmentService.getChapterAssignmentWithAuthContext(
        chapterAssignmentId,
        user.id
      );

    if (!result.ok) {
      return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
    }

    const ctx = result.data;
    const policyUser = { id: user.id, grants: user.grants };
    const policyAssignment = {
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      assignedUserId: ctx.assignedUserId,
      peerCheckerId: ctx.peerCheckerId,
      status: ctx.status,
      updatedAt: ctx.updatedAt,
    };

    let allowed = false;
    switch (action) {
      case CHAPTER_ASSIGNMENT_ACTIONS.READ:
        allowed = ChapterAssignmentPolicy.view(policyUser, policyAssignment, ctx.isProjectMember);
        break;

      case CHAPTER_ASSIGNMENT_ACTIONS.UPDATE:
        allowed = ChapterAssignmentPolicy.update(policyUser, policyAssignment);
        break;

      case CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT:
        allowed = ChapterAssignmentPolicy.submit(policyUser, policyAssignment, ctx.isProjectMember);
        break;

      case CHAPTER_ASSIGNMENT_ACTIONS.DELETE:
        allowed = ChapterAssignmentPolicy.delete(policyUser, policyAssignment);
        break;

      case CHAPTER_ASSIGNMENT_ACTIONS.TOGGLE_AI:
        allowed = ChapterAssignmentPolicy.toggleAi(policyUser, policyAssignment);
        break;

      case CHAPTER_ASSIGNMENT_ACTIONS.IS_PARTICIPANT:
        allowed = ChapterAssignmentPolicy.isParticipant(
          policyUser,
          policyAssignment,
          ctx.isProjectMember
        );
        break;

      case CHAPTER_ASSIGNMENT_ACTIONS.CLAIM:
        allowed = ChapterAssignmentPolicy.claim(policyUser, policyAssignment);
        break;
    }

    if (!allowed) {
      return c.json({ message: 'Chapter assignment not found' }, HttpStatusCodes.NOT_FOUND);
    }

    c.set('chapterAssignment', ctx);
    return next();
  });
}
