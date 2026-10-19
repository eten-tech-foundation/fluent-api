import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentOneOf, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { checkUsfmFilesSchema, usfmFileChecksSchema } from './projects.types';
import * as usfmImportService from './usfm-import.service';

// What zod rejects the body with. No defaultHook is wired (see book-details.route.ts), so
// @hono/zod-validator answers with this shape and a 400.
const validationErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({
    issues: z.array(z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })),
    name: z.string(),
  }),
});

// ─── POST /projects/usfm-validation ──────────────────────────────────────────

const checkUsfmFilesRoute = createRoute({
  tags: ['Projects'],
  method: 'post',
  path: '/projects/usfm-validation',
  // Any signed-in user: the check reads nothing but the books list and writes nothing.
  middleware: [authenticateUser] as const,
  summary: 'Check USFM files before creating a project from them',
  description: [
    'The upload step of "create from existing data" (fluent-web #418, #419). Every file goes through the same book detection and parse as POST /projects with usfmFiles, so a file this accepts is one creation accepts too.',
    'The book comes from `\\id`, else from the name in `\\toc3` or `\\mt` (English names and abbreviations, and Hindi IRV names). Each file gets its own verdict, in upload order: the book it is for, or why it was rejected (USFM_INVALID, USFM_BOOK_MISSING, or USFM_BOOK_DUPLICATE for a second file of the same book). Nothing is stored.',
  ].join(' '),
  request: { body: jsonContentRequired(checkUsfmFilesSchema, 'The files, as text') },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(usfmFileChecksSchema, 'One verdict per file, in order'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContentOneOf(
      [validationErrorSchema, createMessageObjectSchema('Malformed JSON in request body')],
      'Body failed schema validation, or the JSON was malformed'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'User account is inactive'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(checkUsfmFilesRoute, async (c) => {
  const { files } = c.req.valid('json');

  const result = await usfmImportService.checkUsfmFiles(files);
  if (result.ok) return c.json({ files: result.data }, HttpStatusCodes.OK);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
