import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  bible_provider_resources,
  bibles,
  books,
  chapter_assignments,
  languages,
  organizations,
  pericope_sets,
  project_unit_bible_books,
  project_units,
  projects,
  roles,
  user_roles,
  users,
} from '@/db/schema';
import { ROLES } from '@/lib/roles';

export const AUDIO_DEMO_SEED = 'source-audio-bsb-jhn';

/** Only local setup creates a demo project; shared Dev/QA need their own chosen QA assignment. */
export async function seedAudioDemo(
  envName: string,
  orgName: string,
  userEmail?: string
): Promise<void> {
  if (envName !== 'local') return;
  if (!userEmail) throw new Error('Audio demo needs the first configured local seed user.');
  await db
    .insert(bible_provider_resources)
    .values({
      provider: 'aquifer',
      externalId: '20',
      ttsLicenseStatus: 'allowed',
      licenseNotice: 'World English Bible (WEB). Public domain.',
      displayName: 'World English Bible',
    })
    .onConflictDoNothing();

  const [org] = await db.select().from(organizations).where(eq(organizations.name, orgName));
  const [user] = await db.select().from(users).where(eq(users.email, userEmail));
  const [bible] = await db.select().from(bibles).where(eq(bibles.abbreviation, 'BSB'));
  const [book] = await db.select().from(books).where(eq(books.code, 'JHN'));
  const [target] = await db.select().from(languages).where(eq(languages.langCodeIso6393, 'guj'));
  const [pericopes] = await db.select().from(pericope_sets).where(eq(pericope_sets.name, 'FCBH'));
  const [role] = await db.select().from(roles).where(eq(roles.name, ROLES.PROJECT_MANAGER));
  if (!org || !user || !bible || !book || !target || !pericopes || !role) {
    throw new Error(
      'Audio demo needs organization, user, BSB/JHN, Gujarati, FCBH and roles seeded first.'
    );
  }

  await db.transaction(async (tx) => {
    // Projects have no unique seed key. Serialize concurrent setup runs without adding a schema
    // constraint; the metadata marker avoids claiming a user-created project with the same name.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${AUDIO_DEMO_SEED}))`);
    let [project] = await tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.organization, org.id),
          sql`${projects.metadata}->>'seed' = ${AUDIO_DEMO_SEED}`
        )
      );
    if (!project) {
      [project] = await tx
        .insert(projects)
        .values({
          name: 'Source Audio Demo — BSB John',
          sourceLanguage: bible.languageId,
          targetLanguage: target.id,
          organization: org.id,
          createdBy: user.id,
          status: 'active',
          pericopeSetId: pericopes.id,
          metadata: { seed: AUDIO_DEMO_SEED },
        })
        .returning();
    }
    let [unit] = await tx
      .select()
      .from(project_units)
      .where(eq(project_units.projectId, project.id))
      .orderBy(project_units.id);
    if (!unit) {
      [unit] = await tx.insert(project_units).values({ projectId: project.id }).returning();
    }
    const [link] = await tx
      .select()
      .from(project_unit_bible_books)
      .where(
        and(
          eq(project_unit_bible_books.projectUnitId, unit.id),
          eq(project_unit_bible_books.bibleId, bible.id),
          eq(project_unit_bible_books.bookId, book.id)
        )
      );
    if (!link) {
      await tx
        .insert(project_unit_bible_books)
        .values({ projectUnitId: unit.id, bibleId: bible.id, bookId: book.id });
    }
    await tx
      .insert(user_roles)
      .values({
        userId: user.id,
        orgId: org.id,
        projectId: project.id,
        roleId: role.id,
        createdBy: user.id,
      })
      .onConflictDoNothing();
    await tx
      .insert(chapter_assignments)
      .values({
        projectUnitId: unit.id,
        bibleId: bible.id,
        bookId: book.id,
        chapterNumber: 3,
        assignedUserId: user.id,
        isAiEnabled: false,
      })
      .onConflictDoNothing({
        target: [
          chapter_assignments.projectUnitId,
          chapter_assignments.bibleId,
          chapter_assignments.bookId,
          chapter_assignments.chapterNumber,
        ],
      });
    // Reruns retain assignment ownership, progress and the suggestion toggle, not just verse IDs.
    console.log(`Audio demo ready: project ${project.id}, BSB John 3 (local only).`);
  });
}
