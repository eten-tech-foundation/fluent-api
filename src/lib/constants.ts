import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

export const ZOD_ERROR_MESSAGES = {
  REQUIRED: 'Required',
  EXPECTED_NUMBER: 'Expected number, received nan',
  NO_UPDATES: 'No updates provided',
};

export const ZOD_ERROR_CODES = {
  INVALID_UPDATES: 'invalid_updates',
};

export const notFoundSchema = createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND);
export const STALE_THRESHOLD_MINUTES = 2;

/**
 * Maximum value of a signed 32-bit integer (PostgreSQL INTEGER / SERIAL, 2^31 - 1).
 * Values exceeding this bound trigger SQLSTATE 22P02 (integer out of range) in PostgreSQL,
 * which surfaces as an unexpected 500 internal error instead of 400 Bad Request if not
 * guarded in middleware before querying the database.
 */
export const MAX_POSTGRES_INT = 2_147_483_647;
