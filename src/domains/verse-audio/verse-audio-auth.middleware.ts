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

// The assignment lookup also proves the verse belongs to this unit
// (INVALID_REFERENCE → 400). It and the unit→project lookup are independent,
// so they run in parallel; membership still waits on the resolved projectId.
async function loadAssignmentAuthContext(
  projectUnitId: number,
  bibleTextId: number,
  userId: number
) {
  const [assignmentResult, unitResult] = await Promise.all([
    chapterAssignmentService.getAssignmentForVerse(projectUnitId, bibleTextId),
    projectService.getProjectIdByUnitId(projectUnitId),
  ]);

  const isProjectMember = unitResult.ok
    ? await resolveIsProjectMember(unitResult.data.projectId, userId)
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

    const [projectResult, isProjectMember] = await Promise.all([
      projectService.getProjectById(unitResult.data.projectId),
      resolveIsProjectMember(unitResult.data.projectId, user.id),
    ]);
    if (!projectResult.ok) {
      return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
    }

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

    const bibleTextId = Number(c.req.param('bibleTextId'));
    if (!Number.isInteger(bibleTextId) || bibleTextId <= 0) {
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

    const allowed =
      ChapterAssignmentPolicy.resolveAudioConflict(policyUser, assignmentResult.data) ||
      ChapterAssignmentPolicy.edit(policyUser, assignmentResult.data, isProjectMember);

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

    const bibleTextId = Number(c.req.param('bibleTextId'));
    if (!Number.isInteger(bibleTextId) || bibleTextId <= 0) {
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
