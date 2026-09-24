import { createRoute } from '@hono/zod-openapi';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { parseBibleKey } from '@/domains/bible-provider-resources/identity';
import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { isBibleBookLinkedToProject } from '@/domains/source-audio/source-audio.repository';
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
  400: jsonContent(createMessageObjectSchema('Bad Request'), 'Invalid identity or parameters'),
  401: jsonContent(createMessageObjectSchema('Unauthorized'), 'Authentication required'),
  403: jsonContent(createMessageObjectSchema('Forbidden'), 'Project access required'),
  404: jsonContent(createMessageObjectSchema('Not Found'), 'Bible or project not found'),
  500: jsonContent(createMessageObjectSchema('Internal Server Error'), 'Database failure'),
  502: jsonContent(createMessageObjectSchema('Bad Gateway'), 'Provider failure'),
};

server.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{projectId}/bible-resources/{bibleKey}',
    tags: ['Playback Audio'],
    middleware: [...middleware],
    request: { params: projectIdParamSchema.extend({ bibleKey: bibleKeySchema }) },
    responses: {
      200: jsonContent(resourceFactsSchema, 'Exact provider facts; missing records are unknown'),
      ...errors,
    },
  }),
  async (c) => {
    const result = await getResourceFacts(parseBibleKey(c.req.valid('param').bibleKey)!);
    return result.ok
      ? c.json(result.data, 200)
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
      200: jsonContent(playbackAudioResponseSchema, 'Explicit source recording'),
      ...errors,
    },
  }),
  async (c) => {
    const { projectId, bookCode, chapter } = c.req.valid('param');
    const { bibleId, languageCode, verse } = c.req.valid('query');
    const linked = await isBibleBookLinkedToProject(projectId, bibleId, bookCode);
    if (!linked.ok)
      return c.json({ message: linked.error.message }, getHttpStatus(linked.error) as never);
    if (!linked.data) return c.json({ message: 'Not Found' }, 404);
    const result = await getSourcePlayback({
      fluentBibleId: bibleId,
      languageCode,
      bookCode,
      chapter,
      verse,
    });
    return result.ok
      ? c.json(result.data, 200)
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
      200: jsonContent(playbackAudioResponseSchema, 'Exact reference recording'),
      ...errors,
    },
  }),
  async (c) => {
    const { bibleKey, bookCode, chapter } = c.req.valid('param');
    const identity = parseBibleKey(bibleKey)!;
    // DBL references are outside the picker contract.
    if (identity.provider === 'dbl') return c.json({ message: 'Bad Request' }, 400);
    const result = await getReferencePlayback({
      identity,
      bookCode,
      chapter,
      languageCode: c.req.valid('query').languageCode,
    });
    return result.ok
      ? c.json(result.data, 200)
      : c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
);
