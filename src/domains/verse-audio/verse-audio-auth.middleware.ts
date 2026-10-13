import type { Context } from 'hono';

import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppPolicyUser, User } from '@/lib/types';
import type { AppEnv } from '@/server/context.types';

import { ChapterAssignmentPolicy } from '@/domains/chapter-assignments/chapter-assignments.policy';
import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { ErrorMessages, getHttpStatus } from '@/lib/types';

import type { VerseAudioIdSource } from './verse-audio.types';

import { VERSE_AUDIO_ID_SOURCES } from './verse-audio.types';

// Forbidden access is masked as 404 (existence non-disclosure), matching
// translated-verse-auth.middleware.ts.
const NOT_FOUND_MESSAGE = ErrorMessages.VERSE_AUDIO_NOT_FOUND;

interface VerseAudioAuthInputs {
  user: User;
  policyUser: AppPolicyUser;
  projectUnitId: number;
}

function validateMiddlewareInputs(
  c: Context<AppEnv>,
  source: VerseAudioIdSource
): VerseAudioAuthInputs | undefined {
  const user = c.get('user')!;
  const policyUser = { id: user.id, grants: user.grants };

  const projectUnitId =
    source === VERSE_AUDIO_ID_SOURCES.PARAMS
      ? Number(c.req.param('projectUnitId'))
      : Number(c.req.query('projectUnitId'));

  if (!Number.isInteger(projectUnitId) || projectUnitId <= 0) {
    return undefined;
  }

  return { user, policyUser, projectUnitId };
}

function parseBibleTextId(c: Context<AppEnv>): number | undefined {
  const bibleTextId = Number(c.req.param('bibleTextId'));
  return Number.isInteger(bibleTextId) && bibleTextId > 0 ? bibleTextId : undefined;
}

// The assignment lookup also proves the verse belongs to this unit
// (INVALID_REFERENCE → 400) and returns PolicyChapterAssignment including projectId.
// Membership check uses assignmentResult.data.projectId once the assignment lookup succeeds.
async function loadAssignmentAuthContext(
  projectUnitId: number,
  bibleTextId: number,
  userId: number
) {
  const assignmentResult = await chapterAssignmentService.getAssignmentForVerse(
    projectUnitId,
    bibleTextId
  );

  const isProjectMember = assignmentResult.ok
    ? await resolveIsProjectMember(assignmentResult.data.projectId, userId)
    : false;

  return { assignmentResult, isProjectMember };
}

export function requireReadVerseAudioAccess(source: VerseAudioIdSource) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const validInputs = validateMiddlewareInputs(c, source);
    if (!validInputs) {
      return c.json({ message: 'Missing projectUnitId' }, HttpStatusCodes.BAD_REQUEST);
    }

    const { user, policyUser, projectUnitId } = validInputs;

    const unitResult = await projectService.getProjectIdByUnitId(projectUnitId);
    if (!unitResult.ok) {
      return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
    }

    const projectResult = await projectService.getProjectById(unitResult.data.projectId);
    if (!projectResult.ok) {
      return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
    }

    const isProjectMember = await resolveIsProjectMember(unitResult.data.projectId, user.id);

    if (!ProjectPolicy.read(policyUser, projectResult.data, isProjectMember)) {
      return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
    }

    c.set('project', projectResult.data);
    c.set('projectAuthContext', { isProjectMember });

    return next();
  });
}

export function requireResolveVerseAudioConflictAccess(source: VerseAudioIdSource) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const validInputs = validateMiddlewareInputs(c, source);
    if (!validInputs) {
      return c.json({ message: 'Missing projectUnitId' }, HttpStatusCodes.BAD_REQUEST);
    }

    const { user, policyUser, projectUnitId } = validInputs;

    const bibleTextId = parseBibleTextId(c);
    if (bibleTextId === undefined) {
      return c.json({ message: 'Missing bibleTextId' }, HttpStatusCodes.BAD_REQUEST);
    }

    const { assignmentResult } = await loadAssignmentAuthContext(
      projectUnitId,
      bibleTextId,
      user.id
    );
    if (!assignmentResult.ok) {
      return c.json(
        { message: assignmentResult.error.message },
        getHttpStatus(assignmentResult.error) as never
      );
    }

    const allowed = ChapterAssignmentPolicy.resolveAudioConflict(policyUser, assignmentResult.data);

    if (!allowed) {
      return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
    }

    return next();
  });
}

export function requireEditVerseAudioAccess(source: VerseAudioIdSource) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const validInputs = validateMiddlewareInputs(c, source);
    if (!validInputs) {
      return c.json({ message: 'Missing projectUnitId' }, HttpStatusCodes.BAD_REQUEST);
    }

    const { user, policyUser, projectUnitId } = validInputs;

    const bibleTextId = parseBibleTextId(c);
    if (bibleTextId === undefined) {
      return c.json({ message: 'Missing bibleTextId' }, HttpStatusCodes.BAD_REQUEST);
    }

    const { assignmentResult, isProjectMember } = await loadAssignmentAuthContext(
      projectUnitId,
      bibleTextId,
      user.id
    );
    if (!assignmentResult.ok) {
      return c.json(
        { message: assignmentResult.error.message },
        getHttpStatus(assignmentResult.error) as never
      );
    }

    if (!ChapterAssignmentPolicy.edit(policyUser, assignmentResult.data, isProjectMember)) {
      return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
    }

    return next();
  });
}
