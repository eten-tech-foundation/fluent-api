import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as usfmImportService from './milestone-usfm-import.service';
import {
  checkMilestoneUsfmFilesSchema,
  importUsfmMilestoneSchema,
  milestoneResponseSchema,
  milestoneUsfmFileChecksSchema,
  projectIdParamSchema,
  rejectedUsfmImportSchema,
} from './milestones.types';

// What zod rejects the body with. No defaultHook is wired (see book-details.route.ts), so
// @hono/zod-validator answers with this shape and a 400.
const validationErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({
    issues: z.array(z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })),
    name: z.string(),
  }),
});

const accessResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
    createMessageObjectSchema('Unauthorized'),
    'Authentication required'
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    createMessageObjectSchema('Forbidden'),
    'Inactive account, or not allowed to change this project'
  ),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
    'Project not found'
  ),
  [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
    createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
    'Internal server error'
  ),
};

// ─── POST /projects/:projectId/milestones/usfm-validation ─────────────────────

const checkUsfmFilesRoute = createRoute({
  tags: ['Milestones'],
  method: 'post',
  path: '/projects/{projectId}/milestones/usfm-validation',
  // Same gate as POST /projects/{projectId}/milestones: an import is a way to add a milestone.
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Check USFM files for a milestone import',
  description: [
    'The Add Milestone Import tab calls this as each file is added (fluent-web #418). Every file goes through the same book detection and parse as POST /projects/{projectId}/milestones/import, and nothing is stored.',
    "The book comes from `\\id`, else from the name in `\\toc3` or `\\mt` (English names and abbreviations, and Hindi IRV names). Each file gets a verdict in upload order: its book, or why it was refused. USFM_INVALID and USFM_BOOK_MISSING mean no book could be read; USFM_BOOK_DUPLICATE means another file in the upload, or one of `listedBookCodes`, has the book; USFM_BOOK_EXISTS means the project already holds the book, in the named milestone or (`milestoneName: null`) in none; USFM_BOOK_NOT_IN_SOURCE means the project's Source Bible lacks it.",
  ].join(' '),
  request: {
    params: projectIdParamSchema,
    body: jsonContentRequired(checkMilestoneUsfmFilesSchema, 'The files, as text'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      milestoneUsfmFileChecksSchema,
      'One verdict per file, in order'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      z.union([createMessageObjectSchema('Project has no source Bible'), validationErrorSchema]),
      'Body failed schema validation, or the project has no Source Bible'
    ),
    ...accessResponses,
  },
});

server.openapi(checkUsfmFilesRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const { files, listedBookCodes } = c.req.valid('json');
  const { sourceBibleId } = c.get('project')!;
  if (!sourceBibleId) {
    return c.json({ message: 'Project has no source Bible' }, HttpStatusCodes.BAD_REQUEST);
  }

  const result = await usfmImportService.checkUsfmFilesForMilestone(
    projectId,
    sourceBibleId,
    files,
    listedBookCodes
  );
  if (result.ok) return c.json({ files: result.data }, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /projects/:projectId/milestones/import ──────────────────────────────

const importUsfmMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'post',
  path: '/projects/{projectId}/milestones/import',
  // Same gate as POST /projects/{projectId}/milestones: an import is a way to add a milestone.
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Create a milestone from USFM files',
  description: [
    'The Add Milestone Import button (fluent-web #419, #420). Creates one milestone with the given name and the books found in the files; languages, Source Bible, connectivity profile and pericope set come from the project. Each file is stored verbatim, so every tag survives as passthrough data, and its verses become editable once the source book is fully ingested (queued here when it is not).',
    'The files are checked again as in /usfm-validation: if any is refused, nothing is created and the 400 lists every verdict. A book the project gained after that check is caught inside the project lock and answered with 409.',
  ].join(' '),
  request: {
    params: projectIdParamSchema,
    body: jsonContentRequired(importUsfmMilestoneSchema, 'Milestone name and files'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(milestoneResponseSchema, 'Created milestone'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      z.union([rejectedUsfmImportSchema, validationErrorSchema]),
      'A file was refused (every verdict is listed), the body failed schema validation, or the project has no Source Bible (no files)'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('A book in this import already exists in the project'),
      'A book was added to the project while the import was being checked'
    ),
    ...accessResponses,
  },
});

server.openapi(importUsfmMilestoneRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const { name, files } = c.req.valid('json');
  const { sourceBibleId } = c.get('project')!;
  if (!sourceBibleId) {
    return c.json({ message: 'Project has no source Bible' }, HttpStatusCodes.BAD_REQUEST);
  }

  const result = await usfmImportService.importUsfmMilestone(projectId, sourceBibleId, name, files);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  if (result.data.kind === 'rejected') {
    return c.json(
      { message: 'One or more files cannot be imported', files: result.data.files },
      HttpStatusCodes.BAD_REQUEST
    );
  }
  return c.json(result.data.milestone, HttpStatusCodes.CREATED);
});
