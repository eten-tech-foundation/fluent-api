import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

export const unauthorizedResponse = jsonContent(
  createMessageObjectSchema('Unauthorized'),
  'Authentication required'
);
export const inactiveAccountResponse = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.FORBIDDEN),
  'User account is inactive'
);
export const internalErrorResponse = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
  'Internal server error'
);
