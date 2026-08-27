import type { Context } from 'hono';

import type { AppBindings, AppError } from '@/lib/types';

import { ErrorCode, ErrorMessages, getHttpStatus } from '@/lib/types';

/**
 * Map Aquifer-backed route failures to HTTP JSON. Upstream detail is logged
 * server-side; clients only see the generic AQUIFER_SERVICE_UNAVAILABLE message.
 */
export function aquiferErrorResponse(c: Context<AppBindings>, error: AppError) {
  if (error.code === ErrorCode.AQUIFER_SERVICE_UNAVAILABLE) {
    c.get('logger').error(
      {
        aquiferError: error.message,
        code: error.code,
        method: c.req.method,
        path: c.req.path,
        requestId: c.get('requestId'),
        userId: c.get('user')?.id,
        activeOrgId: c.get('activeOrgId'),
      },
      // Detail is repeated in the message so it survives console-only transports,
      // which drop structured properties (see lib/logger.ts).
      `Aquifer upstream failure: ${error.message}`
    );
    return c.json(
      { message: ErrorMessages[ErrorCode.AQUIFER_SERVICE_UNAVAILABLE] },
      getHttpStatus(error) as never
    );
  }
  return c.json({ message: error.message }, getHttpStatus(error) as never);
}
