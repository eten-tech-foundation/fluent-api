import { and, eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_provider_resources } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Provider } from './identity';

async function find(
  where: ReturnType<typeof eq>
): Promise<Result<typeof bible_provider_resources.$inferSelect | null>> {
  try {
    const [row] = await db.select().from(bible_provider_resources).where(where).limit(1);
    return ok(row ?? null);
  } catch (cause) {
    logger.error({ cause, message: 'Failed to read Bible provider resource' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export function getById(id: number) {
  return find(eq(bible_provider_resources.id, id));
}

export function getByProviderIdentity(provider: Provider, externalId: string) {
  return find(
    and(
      eq(bible_provider_resources.provider, provider),
      eq(bible_provider_resources.externalId, externalId)
    )!
  );
}
