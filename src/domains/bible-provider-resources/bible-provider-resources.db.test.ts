import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db';
import { config as localConfig } from '@/db/env-configs/local';
import { bible_provider_resources, bibles, projects } from '@/db/schema';
import { AUDIO_DEMO_SEED, seedAudioDemo } from '@/db/seeds/audio-demo';
import { seedBibles } from '@/db/seeds/bibles';
import { findAssignmentsProgress } from '@/domains/chapter-assignments/chapter-assignments.repository';
import { auth } from '@/lib/auth';
import { server } from '@/server/server';
import '@/domains/playback-audio/playback-audio.route';

import { getById, getByProviderIdentity } from './bible-provider-resources.repository';

const localUser = localConfig.seedUsers[0];
let headers: Headers;
let projectId: number;

beforeAll(async () => {
  const [project] = await db
    .select()
    .from(projects)
    .where(sql`${projects.metadata}->>'seed' = ${AUDIO_DEMO_SEED}`);
  if (!project) throw new Error('Run local db:setup before DB tests');
  projectId = project.id;
  const session = await auth.api.signInEmail({
    body: { email: localUser.email, password: localUser.password },
  });
  headers = new Headers({ Authorization: `Bearer ${session.token}` });
});
afterAll(async () => {
  if (headers) await auth.api.signOut({ headers });
});

describe('independent provider rows, schema and read-only authenticated lookup', () => {
  it('reads an independent row by either key; defaults unknown and enforces composite uniqueness', async () => {
    const externalId = `test-${randomUUID()}`;
    const [row] = await db
      .insert(bible_provider_resources)
      .values({ provider: 'dbl', externalId })
      .returning();
    try {
      expect(row.ttsLicenseStatus).toBe('unknown');
      expect(await getById(row.id)).toEqual({ ok: true, data: row });
      expect(await getByProviderIdentity('dbl', externalId)).toEqual({ ok: true, data: row });
      await expect(
        db.insert(bible_provider_resources).values({ provider: 'dbl', externalId })
      ).rejects.toThrow();
      const response = await server.request(
        `/projects/${projectId}/bible-resources/dbl-${externalId}`,
        { headers }
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: row.id,
        ttsLicenseStatus: 'unknown',
        licenseNotice: null,
      });
    } finally {
      await db.delete(bible_provider_resources).where(eq(bible_provider_resources.id, row.id));
    }
  });
  it('valid missing identity returns 200 unknown without writes; invalid/auth/membership failures stay failures', async () => {
    const before = await db
      .select()
      .from(bible_provider_resources)
      .orderBy(bible_provider_resources.id);
    const path = `/projects/${projectId}/bible-resources/yv-9007199254740991`;
    expect((await server.request(path)).status).toBe(401);
    const response = await server.request(path, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: null,
      ttsLicenseStatus: 'unknown',
      licenseNotice: null,
    });
    expect(
      (await server.request(`/projects/${projectId}/bible-resources/aq-01`, { headers })).status
    ).toBe(400);
    expect(
      (await server.request('/projects/2147483647/bible-resources/aq-1', { headers })).status
    ).toBe(404);
    expect(
      (
        await server.request(
          `/projects/${projectId}/playback-audio/GEN/1?bibleId=2147483647&languageCode=eng`,
          { headers }
        )
      ).status
    ).toBe(404);
    const reference = await server.request(
      `/projects/${projectId}/reference-audio/yv-9007199254740991/JHN/3?languageCode=eng`,
      { headers }
    );
    expect(reference.status).toBe(200);
    expect(await reference.json()).toMatchObject({
      items: [],
      ttsLicenseStatus: 'unknown',
      textBibleKey: 'yv-9007199254740991',
    });
    expect(
      await db.select().from(bible_provider_resources).orderBy(bible_provider_resources.id)
    ).toEqual(before);
  });
  it('prevents deleting an explicitly selected recording resource', async () => {
    const [bible] = await db.select().from(bibles).where(eq(bibles.abbreviation, 'BSB'));
    expect(bible.audioResourceId).not.toBeNull();
    await expect(
      db
        .delete(bible_provider_resources)
        .where(eq(bible_provider_resources.id, bible.audioResourceId!))
    ).rejects.toThrow();
  });
  it('reruns seeds preserving blank notice, curated clearance and a nondefault recording selection', async () => {
    const [bible] = await db.select().from(bibles).where(eq(bibles.abbreviation, 'BSB'));
    const [text] = await db
      .select()
      .from(bible_provider_resources)
      .where(
        and(
          eq(bible_provider_resources.provider, 'dbl'),
          eq(bible_provider_resources.externalId, bible.externalId!)
        )
      );
    const [audio] = await db
      .select()
      .from(bible_provider_resources)
      .where(eq(bible_provider_resources.id, bible.audioResourceId!));
    const [alternate] = await db
      .insert(bible_provider_resources)
      .values({
        provider: 'dbl',
        externalId: `test-audio-${randomUUID()}`,
        ttsLicenseStatus: 'allowed',
      })
      .returning();
    try {
      await db
        .update(bible_provider_resources)
        .set({ ttsLicenseStatus: 'forbidden', licenseNotice: '' })
        .where(eq(bible_provider_resources.id, text.id));
      await db
        .update(bible_provider_resources)
        .set({ licenseNotice: '' })
        .where(eq(bible_provider_resources.id, audio.id));
      await db.update(bibles).set({ audioResourceId: alternate.id }).where(eq(bibles.id, bible.id));
      await seedBibles();
      await seedAudioDemo('local', localConfig.orgName, localUser.email);
      expect(await getById(text.id)).toMatchObject({
        ok: true,
        data: { ttsLicenseStatus: 'forbidden', licenseNotice: '' },
      });
      expect(await getById(audio.id)).toMatchObject({ ok: true, data: { licenseNotice: '' } });
      const [after] = await db.select().from(bibles).where(eq(bibles.id, bible.id));
      expect(after.audioResourceId).toBe(alternate.id);
      const progress = await findAssignmentsProgress({ projectId });
      expect(progress.ok).toBe(true);
      if (!progress.ok) throw new Error(progress.error.message);
      expect(progress.data).not.toHaveLength(0);
      for (const row of progress.data) {
        expect(row).toMatchObject({
          ttsLicenseStatus: 'forbidden',
          textBibleKey: `dbl-${bible.externalId}`,
          selectedRecordingKey: `dbl-${alternate.externalId}`,
          totalVerses: 36,
        });
      }
    } finally {
      await db
        .update(bibles)
        .set({ audioResourceId: bible.audioResourceId, updatedAt: bible.updatedAt })
        .where(eq(bibles.id, bible.id));
      await db
        .update(bible_provider_resources)
        .set({ ttsLicenseStatus: text.ttsLicenseStatus, licenseNotice: text.licenseNotice })
        .where(eq(bible_provider_resources.id, text.id));
      await db
        .update(bible_provider_resources)
        .set({ licenseNotice: audio.licenseNotice })
        .where(eq(bible_provider_resources.id, audio.id));
      await db
        .delete(bible_provider_resources)
        .where(eq(bible_provider_resources.id, alternate.id));
    }
  });
});
