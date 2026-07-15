import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { ChapterAssignmentPolicy } from '@/domains/chapter-assignments/chapter-assignments.policy';
import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { ErrorMessages, getHttpStatus } from '@/lib/types';

import type { VerseAudioAction, VerseAudioIdSource } from './verse-audio.types';

import { VERSE_AUDIO_ACTIONS, VERSE_AUDIO_ID_SOURCES } from './verse-audio.types';

// Forbidden access is masked as 404 (existence non-disclosure), matching
// translated-verse-auth.middleware.ts.
const NOT_FOUND_MESSAGE = ErrorMessages.VERSE_AUDIO_NOT_FOUND;

/**
 * Resolves the parent project (READ) or chapter assignment (EDIT) for a verse
 * audio route and evaluates the matching policy. IDs always come from path
 * params or the query string — never the multipart body.
 */
export function requireVerseAudioAccess(action: VerseAudioAction, source: VerseAudioIdSource) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;
    const policyUser = {
      id: user.id,
      role: user.role,
      roleName: user.roleName,
      organization: user.organization,
    };

    const projectUnitId =
      source === VERSE_AUDIO_ID_SOURCES.PARAMS
        ? Number(c.req.param('projectUnitId'))
        : Number(c.req.query('projectUnitId'));

    if (!projectUnitId || Number.isNaN(projectUnitId)) {
      return c.json({ message: 'Missing projectUnitId' }, HttpStatusCodes.BAD_REQUEST);
    }

    if (action === VERSE_AUDIO_ACTIONS.READ) {
      const unitResult = await projectService.getProjectIdByUnitId(projectUnitId);
      if (!unitResult.ok) {
        return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
      }

      const projectResult = await projectService.getProjectById(unitResult.data.projectId);
      if (!projectResult.ok) {
        return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
      }

      const isProjectMember = await resolveIsProjectMember(
        unitResult.data.projectId,
        user.id,
        user.roleName
      );

      if (!ProjectPolicy.read(policyUser, projectResult.data, isProjectMember)) {
        return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
      }

      c.set('project', projectResult.data);
      c.set('projectAuthContext', { isProjectMember });
    } else {
      const bibleTextId = Number(c.req.param('bibleTextId'));
      if (!bibleTextId || Number.isNaN(bibleTextId)) {
        return c.json({ message: 'Missing bibleTextId' }, HttpStatusCodes.BAD_REQUEST);
      }

      // Also proves the verse belongs to this unit (INVALID_REFERENCE → 400).
      const assignmentResult = await chapterAssignmentService.getAssignmentForVerse(
        projectUnitId,
        bibleTextId
      );
      if (!assignmentResult.ok) {
        return c.json(
          { message: assignmentResult.error.message },
          getHttpStatus(assignmentResult.error) as never
        );
      }

      const unitResult = await projectService.getProjectIdByUnitId(projectUnitId);
      const isProjectMember = unitResult.ok
        ? await resolveIsProjectMember(unitResult.data.projectId, user.id, user.roleName)
        : false;

      if (!ChapterAssignmentPolicy.edit(policyUser, assignmentResult.data, isProjectMember)) {
        return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);
      }
    }

    return next();
  });
}
