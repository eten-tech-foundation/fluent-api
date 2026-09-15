import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db';
import { config as localConfig } from '@/db/env-configs/local';
import {
  bible_texts,
  bibles,
  chapter_assignments,
  project_unit_bible_books,
  project_units,
  projects,
  translated_verses,
  users,
} from '@/db/schema';
import { findAssignmentsProgress } from '@/domains/chapter-assignments/chapter-assignments.repository';
import { getChapterPericopes } from '@/domains/pericopes/pericopes.service';
import { getAssignedChaptersByUserId } from '@/domains/users/chapter-assignments/users-chapter-assignments.service';
import { auth } from '@/lib/auth';
import { server } from '@/server/server';
import '@/domains/bibles/bibles.route';
import '@/domains/bibles/bible-texts/bible-texts.route';
import '@/domains/source-audio/source-audio.route';

import { AUDIO_DEMO_SEED, seedAudioDemo } from './audio-demo';
import { seedBsbBibleTexts } from './bible-texts-bsb';
import { seedBibles } from './bibles';

const localUser = localConfig.seedUsers[0];

async function fixture() {
  const [bible] = await db.select().from(bibles).where(eq(bibles.abbreviation, 'BSB'));
  const [user] = await db.select().from(users).where(eq(users.email, localUser.email));
  const [project] = await db
    .select()
    .from(projects)
    .where(sql`${projects.metadata}->>'seed' = ${AUDIO_DEMO_SEED}`);
  if (!bible || !user || !project) throw new Error('Run local platform db:setup first.');
  const [unit] = await db
    .select()
    .from(project_units)
    .where(eq(project_units.projectId, project.id));
  if (!unit) throw new Error('Demo project unit missing');
  const [assignment] = await db
    .select()
    .from(chapter_assignments)
    .where(
      and(eq(chapter_assignments.projectUnitId, unit.id), eq(chapter_assignments.chapterNumber, 3))
    );
  if (!assignment) throw new Error('Demo assignment missing');
  return { bible, user, project, unit, assignment };
}

describe('seeded BSB audio fixture (real database and authentication)', () => {
  let headers: { Authorization: string };
  beforeAll(async () => {
    await fixture();
    const login = await auth.api.signInEmail({
      body: { email: localUser.email, password: localUser.password },
    });
    headers = { Authorization: `Bearer ${login.token}` };
  });

  it('publishes allowed + notice on GET /bibles and GET /bibles/{id}', async () => {
    const { bible } = await fixture();
    const res = await server.request(`/bibles/${bible.id}`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: bible.id,
      provider: 'dbl',
      ttsLicenseStatus: 'allowed',
      licenseNotice: 'Berean Standard Bible (BSB). Public domain.',
    });
    const list = await server.request('/bibles', { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ abbreviation: 'BSB', ttsLicenseStatus: 'allowed' }),
        expect.objectContaining({ abbreviation: 'IRV', ttsLicenseStatus: 'unknown' }),
      ])
    );
    const unknown = await db.select().from(bibles).where(eq(bibles.ttsLicenseStatus, 'unknown'));
    expect(unknown.map((row) => row.abbreviation)).toContain('IRV');
    expect(await db.select().from(bibles).where(eq(bibles.ttsLicenseStatus, 'forbidden'))).toEqual(
      []
    );
  });

  it('gives the seeded user a drafting assignment with 36 texts and pericope coverage', async () => {
    const { bible, user, project, assignment } = await fixture();
    const assigned = await getAssignedChaptersByUserId(user.id, project.organization);
    expect(assigned).toMatchObject({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          chapterAssignmentId: assignment.id,
          bibleId: bible.id,
          totalVerses: 36,
          ttsLicenseStatus: 'allowed',
          licenseNotice: 'Berean Standard Bible (BSB). Public domain.',
          isAiEnabled: false,
        }),
      ]),
    });
    const texts = await server.request(
      `/bibles/${bible.id}/books/${assignment.bookId}/chapters/3/texts`,
      { headers }
    );
    expect(texts.status).toBe(200);
    expect(await texts.json()).toHaveLength(36);
    const pericopes = await getChapterPericopes(project.id, 'JHN', 3);
    expect(pericopes.ok).toBe(true);
    if (!pericopes.ok) throw new Error('Pericope lookup failed');
    const verses = pericopes.data.flatMap((group) =>
      group.verses.map((verse) => verse.verseNumber)
    );
    expect([...new Set(verses)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1)
    );
  });

  it('executes the aggregated progress query with Bible licence columns and unchanged assignment grain', async () => {
    const { bible, project, assignment } = await fixture();
    const progress = await findAssignmentsProgress({ projectId: project.id });
    expect(progress.ok).toBe(true);
    if (!progress.ok) throw new Error('Assignment progress query failed');
    const matching = progress.data.filter((row) => row.assignmentId === assignment.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      bibleId: bible.id,
      ttsLicenseStatus: bible.ttsLicenseStatus,
      licenseNotice: bible.licenseNotice,
      totalVerses: 36,
    });
  });

  it('reruns shared seeds without replacing verses, assignments or translator work', async () => {
    const { bible, user, project, unit, assignment } = await fixture();
    const before = await db
      .select()
      .from(bible_texts)
      .where(eq(bible_texts.bibleId, bible.id))
      .orderBy(bible_texts.id);
    expect(before).toHaveLength(878);
    const verse = before.find((row) => row.chapterNumber === 3 && row.verseNumber === 1)!;
    const [draft] = await db
      .insert(translated_verses)
      .values({
        projectUnitId: unit.id,
        bibleTextId: verse.id,
        assignedUserId: user.id,
        content: 'Seed rerun sentinel',
      })
      .onConflictDoNothing()
      .returning();
    try {
      const translationsBefore = await db
        .select()
        .from(translated_verses)
        .where(eq(translated_verses.projectUnitId, unit.id))
        .orderBy(translated_verses.id);
      await seedBibles();
      await seedBsbBibleTexts();
      await seedAudioDemo('local', localConfig.orgName, localUser.email);
      const after = await fixture();
      expect(after.bible).toMatchObject({
        aquiferBibleId: 1,
        ttsLicenseStatus: 'allowed',
        licenseNotice: expect.any(String),
      });
      expect(after.project.id).toBe(project.id);
      expect(after.assignment).toEqual(assignment);
      expect(
        await db
          .select()
          .from(bible_texts)
          .where(eq(bible_texts.bibleId, bible.id))
          .orderBy(bible_texts.id)
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(project_unit_bible_books)
          .where(eq(project_unit_bible_books.projectUnitId, unit.id))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(translated_verses)
          .where(eq(translated_verses.projectUnitId, unit.id))
          .orderBy(translated_verses.id)
      ).toEqual(translationsBefore);
    } finally {
      if (draft) await db.delete(translated_verses).where(eq(translated_verses.id, draft.id));
    }
  });

  it('never creates the demo for shared Dev or QA, even without configured users', async () => {
    const before = await db.select().from(projects).orderBy(projects.id);
    await seedAudioDemo('dev', 'Not a real org');
    await seedAudioDemo('qa', 'Not a real org');
    expect(await db.select().from(projects).orderBy(projects.id)).toEqual(before);
  });
});
