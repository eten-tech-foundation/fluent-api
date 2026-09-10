import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { config as localConfig } from '@/db/env-configs/local';
import { bibles, languages, projects } from '@/db/schema';
import { AUDIO_DEMO_SEED } from '@/db/seeds/audio-demo';
import env from '@/env';
import { auth } from '@/lib/auth';
import * as aquifer from '@/lib/services/aquifer/aquifer.client';
import { server } from '@/server/server';

import { getChapterSourceAudio } from './source-audio.service';
import { sourceAudioResponseSchema } from './source-audio.types';
import './source-audio.route';

// Opt-in provider tests: no request mocks, no extra database. Use the normal seeded local
// platform. BSB exercises real auth/project access and the wire; IRV Hindi exercises the
// windowless branch with temporary Hindi language/Bible rows, deleted in finally; existing
// language rows are reused, never modified or deleted.
// DBL timecodes are NOT live-proven by this suite; only contract-shaped unit fixtures cover them.
describe('source-audio resolver against live Aquifer', () => {
  let headers: Headers | undefined;
  beforeAll(async () => {
    const database = new URL(env.DATABASE_URL);
    if (
      !['localhost', '127.0.0.1', '[::1]', 'db'].includes(database.hostname) ||
      database.pathname !== '/fluent'
    ) {
      throw new Error(
        'Source-audio live tests require the normal local Fluent database, never shared Dev/QA.'
      );
    }
    if (!aquifer.isAquiferConfigured()) throw new Error('Live Aquifer key is required.');
    const user = localConfig.seedUsers[0];
    const login = await auth.api.signInEmail({
      body: { email: user.email, password: user.password },
    });
    headers = new Headers({ Authorization: `Bearer ${login.token}` });
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (headers) await auth.api.signOut({ headers });
  });

  it('the seeded BSB John 3 returns 36 complete windows through the seeded project route, with one catalogue call', async () => {
    const [bible] = await db.select().from(bibles).where(eq(bibles.abbreviation, 'BSB'));
    const [project] = await db
      .select()
      .from(projects)
      .where(sql`${projects.metadata}->>'seed' = ${AUDIO_DEMO_SEED}`);
    if (!bible || !project) throw new Error('Run local platform db:setup first (BSB audio demo).');
    expect(bible.aquiferBibleId).toBe(1);
    const catalogue = vi.spyOn(aquifer, 'getBibles'); // Call-through spy, not a fixture response.
    const text = vi.spyOn(aquifer, 'getBibleText');
    const endpoint = `/projects/${project.id}/source-audio/JHN/3?languageCode=eng&bibleId=${bible.id}`;
    const res = await server.request(endpoint, { headers });
    expect(res.status).toBe(200);
    const response: unknown = await res.json();
    const audio = sourceAudioResponseSchema.parse(response);
    expect(audio).toMatchObject({
      provider: 'aquifer',
      verseAddressable: true,
      bible: { fluentBibleId: bible.id, aquiferBibleId: 1 },
      ttsLicenseStatus: 'allowed',
    });
    expect(audio.items.map((item) => item.format)).toEqual(['mp3', 'webm']);
    expect(audio.verseTimestamps?.map((verse) => verse.verse)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1)
    );
    for (const verse of audio.verseTimestamps ?? []) {
      expect(verse.startSeconds).toBeGreaterThanOrEqual(0);
      expect(verse.endSeconds).toBeGreaterThan(verse.startSeconds!);
    }
    expect(catalogue).toHaveBeenCalledExactlyOnceWith('eng');
    expect(text).toHaveBeenCalledExactlyOnceWith({
      aquiferBibleId: 1,
      bookCode: 'JHN',
      startChapter: 3,
      endChapter: 3,
      includeAudio: true,
    });

    // Optional one-shot capture for downstream resolver tests. Never includes auth headers.
    // Normal test runs do not write fixtures; in Compose, choose a writable /tmp path.
    if (process.env.SOURCE_AUDIO_CAPTURE_PATH) {
      for (const item of audio.items) {
        const url = new URL(item.url);
        if (url.protocol !== 'https:' || url.search || url.username || url.password) {
          throw new Error(
            'Refusing to capture potentially signed or credential-bearing audio URLs.'
          );
        }
      }
      await writeFile(
        process.env.SOURCE_AUDIO_CAPTURE_PATH,
        `${JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            endpoint: `GET ${endpoint}`,
            providerEndpoint:
              'GET https://api.aquifer.bible/bibles/1/texts?BookCode=JHN&StartChapter=3&EndChapter=3&shouldReturnAudioData=true',
            response,
          },
          null,
          2
        )}\n`
      );
    }
  });

  it('the IRV Hindi John 1 chapter is measured windowless and the resolver labels it false', async () => {
    // Normal seeds include Gujarati, not Hindi. Provision only this test's missing reference
    // row, rather than requiring a new permanent seed just to cover a provider's negative case.
    const [insertedLanguage] = await db
      .insert(languages)
      .values({
        langName: 'Hindi',
        langCodeIso6393: 'hin',
      })
      .onConflictDoNothing({ target: languages.langCodeIso6393 })
      .returning();
    let temporaryBibleId: number | undefined;
    try {
      const [language] = await db
        .select()
        .from(languages)
        .where(eq(languages.langCodeIso6393, 'hin'));
      if (!language) throw new Error('Could not resolve Hindi live-test language.');
      const suffix = randomUUID();
      const [bible] = await db
        .insert(bibles)
        .values({
          name: `IRV Hindi live verification ${suffix}`,
          abbreviation: `live-${suffix}`,
          languageId: language.id,
          aquiferBibleId: 2,
        })
        .returning();
      if (!bible) throw new Error('Could not create temporary live-test Bible.');
      temporaryBibleId = bible.id;
      const catalogue = vi.spyOn(aquifer, 'getBibles');
      const text = vi.spyOn(aquifer, 'getBibleText');
      const result = await getChapterSourceAudio({
        fluentBibleId: bible.id,
        languageCode: 'hin',
        bookCode: 'JHN',
        chapter: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      const audio = sourceAudioResponseSchema.parse(result.data);
      expect(audio).toMatchObject({
        provider: 'aquifer',
        verseAddressable: false,
        bible: { aquiferBibleId: 2 },
      });
      expect(audio.items.length).toBeGreaterThan(0);
      expect(audio).not.toHaveProperty('verseTimestamps');
      expect(catalogue).toHaveBeenCalledExactlyOnceWith('hin');
      expect(text).toHaveBeenCalledExactlyOnceWith({
        aquiferBibleId: 2,
        bookCode: 'JHN',
        startChapter: 1,
        endChapter: 1,
        includeAudio: true,
      });
      // Re-measure the actual chapter, not just a boolean the mapper might compute wrongly.
      const raw: Awaited<ReturnType<typeof aquifer.getBibleText>> =
        await text.mock.results[0]!.value;
      expect(raw.ok).toBe(true);
      if (!raw.ok) throw new Error(raw.error.message);
      expect(raw.data.chapters[0]?.verses).toHaveLength(51);
      expect(raw.data.chapters[0]?.verses.every((v) => v.audioTimestamp == null)).toBe(true);
    } finally {
      if (temporaryBibleId !== undefined)
        await db.delete(bibles).where(eq(bibles.id, temporaryBibleId));
      if (insertedLanguage) await db.delete(languages).where(eq(languages.id, insertedLanguage.id));
    }
  });
});
