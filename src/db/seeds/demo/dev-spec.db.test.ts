import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db';
import { config as localConfig } from '@/db/env-configs/local';
import { bible_provider_resources, bibles } from '@/db/schema';
import { IRV_BIBLE } from '@/db/seeds/reference-bibles';

import { seedDemoSpec } from './index';

let irv: { id: number; hasAudio: boolean; audioResourceId: number | null };

beforeAll(async () => {
  const [bible] = await db
    .select({ id: bibles.id, hasAudio: bibles.hasAudio, audioResourceId: bibles.audioResourceId })
    .from(bibles)
    .where(and(eq(bibles.provider, 'dbl'), eq(bibles.externalId, IRV_BIBLE.externalId)));
  if (!bible) throw new Error('Run local db:setup before DB tests');
  irv = bible;
});

describe('seedDemoSpec on the local spec (real database)', () => {
  it('preserves a curated recording and operator license state across a reseed', async () => {
    if (!localConfig.demoSpec) throw new Error('local config must declare a demoSpec');
    const [text] = await db
      .select()
      .from(bible_provider_resources)
      .where(
        and(
          eq(bible_provider_resources.provider, 'dbl'),
          eq(bible_provider_resources.externalId, IRV_BIBLE.externalId)
        )
      );
    const [audio] = await db
      .select()
      .from(bible_provider_resources)
      .where(
        and(
          eq(bible_provider_resources.provider, 'dbl'),
          eq(bible_provider_resources.externalId, IRV_BIBLE.audioExternalId)
        )
      );
    const [alternate] = await db
      .insert(bible_provider_resources)
      .values({
        provider: 'dbl',
        externalId: `test-audio-${randomUUID()}`,
        ttsLicenseStatus: 'allowed',
      })
      .returning();
    try {
      // Operator actions a reseed must not undo: pick a different recording,
      // turn audio off, block the TTS license, rename the audio resource.
      await db
        .update(bibles)
        .set({ audioResourceId: alternate.id, hasAudio: false })
        .where(eq(bibles.id, irv.id));
      await db
        .update(bible_provider_resources)
        .set({ ttsLicenseStatus: 'forbidden', licenseNotice: 'operator note' })
        .where(eq(bible_provider_resources.id, text.id));
      await db
        .update(bible_provider_resources)
        .set({ displayName: 'renamed by operator' })
        .where(eq(bible_provider_resources.id, audio.id));

      await seedDemoSpec(localConfig.demoSpec);

      const [after] = await db.select().from(bibles).where(eq(bibles.id, irv.id));
      expect(after.audioResourceId).toBe(alternate.id);
      expect(after.hasAudio).toBe(false);
      const [afterText] = await db
        .select()
        .from(bible_provider_resources)
        .where(eq(bible_provider_resources.id, text.id));
      expect(afterText.ttsLicenseStatus).toBe('forbidden');
      expect(afterText.licenseNotice).toBe('operator note');
      const [afterAudio] = await db
        .select()
        .from(bible_provider_resources)
        .where(eq(bible_provider_resources.id, audio.id));
      expect(afterAudio.displayName).toBe('renamed by operator');
    } finally {
      await db
        .update(bibles)
        .set({ audioResourceId: irv.audioResourceId, hasAudio: irv.hasAudio })
        .where(eq(bibles.id, irv.id));
      await db
        .update(bible_provider_resources)
        .set({ ttsLicenseStatus: text.ttsLicenseStatus, licenseNotice: text.licenseNotice })
        .where(eq(bible_provider_resources.id, text.id));
      await db
        .update(bible_provider_resources)
        .set({ displayName: audio.displayName })
        .where(eq(bible_provider_resources.id, audio.id));
      await db
        .delete(bible_provider_resources)
        .where(eq(bible_provider_resources.id, alternate.id));
    }
  });
});
