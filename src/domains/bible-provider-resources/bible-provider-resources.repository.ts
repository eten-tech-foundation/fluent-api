import { and, eq, inArray, or, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_provider_resources, bibles } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Provider, ProviderIdentity } from './bible-provider-resources.types';

export type BibleProviderResource = typeof bible_provider_resources.$inferSelect;

export interface LicenseFactsPatch {
  ttsLicenseStatus?: BibleProviderResource['ttsLicenseStatus'];
  licenseNotice?: string | null;
  displayName?: string | null;
}

async function find(where: ReturnType<typeof eq>): Promise<Result<BibleProviderResource | null>> {
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

export async function getByIds(ids: number[]) {
  if (ids.length === 0) return ok<BibleProviderResource[]>([]);
  try {
    return ok(
      await db
        .select()
        .from(bible_provider_resources)
        .where(inArray(bible_provider_resources.id, ids))
    );
  } catch (cause) {
    logger.error({ cause, message: 'Failed to read Bible provider resources by IDs' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByProviderIdentities(identities: ProviderIdentity[]) {
  if (identities.length === 0) return ok<BibleProviderResource[]>([]);
  try {
    return ok(
      await db
        .select()
        .from(bible_provider_resources)
        .where(
          or(
            ...identities.map(({ provider, externalId }) =>
              and(
                eq(bible_provider_resources.provider, provider),
                eq(bible_provider_resources.externalId, externalId)
              )
            )
          )
        )
    );
  } catch (cause) {
    logger.error({ cause, message: 'Failed to read Bible provider resources by identities' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Bump `bibles.updated_at` for every bible that surfaces this resource as text
 * identity (`provider`+`externalId`) or selected recording (`audio_resource_id`).
 * Catalogue `updatedAfter` filters on `bibles.updated_at` only.
 */
function linkedBibleWhere(resource: Pick<BibleProviderResource, 'id' | 'provider' | 'externalId'>) {
  // Text identity lives on `bibles.provider` (DBL-only enum). Non-DBL resources
  // only watermark bibles that selected them as `audio_resource_id`.
  const textIdentity =
    resource.provider === 'dbl'
      ? and(eq(bibles.provider, 'dbl'), eq(bibles.externalId, resource.externalId))
      : undefined;
  return textIdentity
    ? or(eq(bibles.audioResourceId, resource.id), textIdentity)
    : eq(bibles.audioResourceId, resource.id);
}

export async function touchLinkedBibles(
  resource: Pick<BibleProviderResource, 'id' | 'provider' | 'externalId'>
): Promise<Result<{ touched: number }>> {
  try {
    const touched = await db
      .update(bibles)
      .set({ updatedAt: sql`now()` })
      .where(linkedBibleWhere(resource))
      .returning({ id: bibles.id });
    return ok({ touched: touched.length });
  } catch (cause) {
    logger.error({
      cause,
      message: 'Failed to bump bibles.updated_at for provider resource',
      context: { resourceId: resource.id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Update license/display facts on a provider resource and advance watermarks on
 * every linked bible so incremental `/bibles?updatedAfter=` sync observes the change.
 */
export async function updateLicenseFacts(
  id: number,
  patch: LicenseFactsPatch
): Promise<Result<BibleProviderResource>> {
  if (
    patch.ttsLicenseStatus === undefined &&
    patch.licenseNotice === undefined &&
    patch.displayName === undefined
  ) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bible_provider_resources)
        .set({
          ...(patch.ttsLicenseStatus !== undefined
            ? { ttsLicenseStatus: patch.ttsLicenseStatus }
            : {}),
          ...(patch.licenseNotice !== undefined ? { licenseNotice: patch.licenseNotice } : {}),
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        })
        .where(eq(bible_provider_resources.id, id))
        .returning();
      if (!updated) return err(ErrorCode.NOT_FOUND);

      await tx
        .update(bibles)
        .set({ updatedAt: sql`now()` })
        .where(linkedBibleWhere(updated));

      return ok(updated);
    });
  } catch (cause) {
    logger.error({
      cause,
      message: 'Failed to update Bible provider resource license facts',
      context: { id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
