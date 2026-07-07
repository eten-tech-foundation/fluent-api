import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as selfSettingsService from './self-settings.service';
import { saveUserSettingsRequestSchema, userSettingsResponseSchema } from './self-settings.types';

// ─── GET /self/settings ───────────────────────────────────────────────────────
// User-global preference store for the current session user. No `{userId}` in the
// path and no resource to scope, so `authenticateUser` alone guards it (W7).

const getSelfSettingsRoute = createRoute({
  tags: ['Self - Settings'],
  method: 'get',
  path: '/self/settings',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userSettingsResponseSchema,
      'The settings for the current user (settings is null when no row exists yet)'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.FORBIDDEN),
      'User account is inactive'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get settings for current user',
  description: 'Returns the saved user-global settings blob for the current session user.',
});

server.openapi(getSelfSettingsRoute, async (c) => {
  const currentUser = c.get('user')!;

  const result = await selfSettingsService.getSettings(currentUser.id);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  // Derive the status from the error code (matches the PUT handler and the rest
  // of the codebase) rather than hardcoding 500: getSettings only surfaces repo
  // errors (→ 500) today, but this stays correct if it gains new failure modes.
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PUT /self/settings ───────────────────────────────────────────────────────
// Full-replace upsert: the client GETs, merges in memory, and PUTs the whole blob
// (last-writer-wins; no PATCH / ETags / optimistic concurrency — §8.3).

const saveSelfSettingsRoute = createRoute({
  tags: ['Self - Settings'],
  method: 'put',
  path: '/self/settings',
  middleware: [authenticateUser] as const,
  request: {
    body: jsonContent(saveUserSettingsRequestSchema, 'The settings blob to save (full replace)'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(userSettingsResponseSchema, 'The saved settings'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid settings payload'
    ),
    // A well-formed request whose body fails schema validation is surfaced as
    // 422 by the service (ErrorCode.VALIDATION_ERROR → getHttpStatus → 422), and
    // the route test asserts it. Declare it here so the published OpenAPI
    // contract advertises the real client-error surface (the paired fluent-web
    // PR generates types/docs from this spec).
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema('Unprocessable Entity'),
      'Settings payload failed schema validation'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.FORBIDDEN),
      'User account is inactive'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Save settings for current user',
  description: 'Replaces the user-global settings blob for the current session user.',
});

server.openapi(saveSelfSettingsRoute, async (c) => {
  const { settings } = c.req.valid('json');
  const currentUser = c.get('user')!;

  const result = await selfSettingsService.upsertSettings(currentUser.id, settings);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
