import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { parseBibleKey } from '@/domains/bible-provider-resources/bible-provider-resources.identity';
import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { isBibleBookLinkedToProject } from '@/domains/source-audio/source-audio.service';
import {
  chapterSourceAudioParamSchema,
  sourceAudioQuerySchema,
} from '@/domains/source-audio/source-audio.types';
import {
  languageCodeQuerySchema,
  projectIdParamSchema,
} from '@/domains/translation-resources/translation-resources.types';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import {
  getReferencePlayback,
  getResourceFacts,
  getSourcePlayback,
} from './playback-audio.service';
import {
  bibleKeySchema,
  playbackAudioResponseSchema,
  resourceFactsSchema,
} from './playback-audio.types';

const middleware = [
  authenticateUser,
  requirePermission(PERMISSIONS.PROJECT_VIEW),
  requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
] as const;
const errors = {
  [HttpStatusCodes.BAD_REQUEST]: jsonContent(
    createMessageObjectSchema('Bad Request'),
    'Invalid identity or parameters'
  ),
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
    createMessageObjectSchema('Unauthorized'),
    'Authentication required'
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    createMessageObjectSchema('Forbidden'),
    'Project access required'
  ),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    createMessageObjectSchema('Not Found'),
    'Bible or project not found'
  ),
  [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
    createMessageObjectSchema('Internal Server Error'),
    'Database failure'
  ),
  [HttpStatusCodes.BAD_GATEWAY]: jsonContent(
    createMessageObjectSchema('Bad Gateway'),
    'Provider failure'
  ),
  [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
    createMessageObjectSchema('Service Unavailable'),
    'Provider is not configured'
  ),
};

server.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{projectId}/bible-resources/{bibleKey}',
    tags: ['Playback Audio'],
    middleware: [...middleware],
    request: { params: projectIdParamSchema.extend({ bibleKey: bibleKeySchema }) },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(
        resourceFactsSchema,
        'Exact provider facts; missing records are unknown'
      ),
      ...errors,
    },
  }),
  async (c) => {
    const result = await getResourceFacts(parseBibleKey(c.req.valid('param').bibleKey)!);
    return result.ok
      ? c.json(result.data, HttpStatusCodes.OK)
      : c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
);

server.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{projectId}/playback-audio/{bookCode}/{chapter}',
    tags: ['Playback Audio'],
    middleware: [...middleware],
    request: { params: chapterSourceAudioParamSchema, query: sourceAudioQuerySchema },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(playbackAudioResponseSchema, 'Explicit source recording'),
      ...errors,
    },
  }),
  async (c) => {
    const { projectId, bookCode, chapter } = c.req.valid('param');
    const { bibleId, languageCode, verse } = c.req.valid('query');
    const linked = await isBibleBookLinkedToProject(projectId, bibleId, bookCode);
    if (!linked.ok)
      return c.json({ message: linked.error.message }, getHttpStatus(linked.error) as never);
    if (!linked.data) return c.json({ message: 'Not Found' }, HttpStatusCodes.NOT_FOUND);
    const result = await getSourcePlayback({
      fluentBibleId: bibleId,
      languageCode,
      bookCode,
      chapter,
      verse,
    });
    return result.ok
      ? c.json(result.data, HttpStatusCodes.OK)
      : c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
);

server.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{projectId}/reference-audio/{bibleKey}/{bookCode}/{chapter}',
    tags: ['Playback Audio'],
    middleware: [...middleware],
    request: {
      params: chapterSourceAudioParamSchema.extend({ bibleKey: bibleKeySchema }),
      query: languageCodeQuerySchema,
    },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(
        playbackAudioResponseSchema,
        'Exact reference recording. DBL is supported on a best-effort basis: the current picker exposes no DBL reference choices, and live DBL timecodes were absent in the measured catalogue, so this path is contract-tested rather than live-proven.'
      ),
      ...errors,
    },
  }),
  async (c) => {
    const { bibleKey, bookCode, chapter } = c.req.valid('param');
    const identity = parseBibleKey(bibleKey)!;
    const result = await getReferencePlayback({
      identity,
      bookCode,
      chapter,
      languageCode: c.req.valid('query').languageCode,
    });
    return result.ok
      ? c.json(result.data, HttpStatusCodes.OK)
      : c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
);
