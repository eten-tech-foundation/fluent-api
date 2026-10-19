import { and, eq, isNull, sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';

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
const AUDIO_DEMO_PROJECT_NAME = 'Source Audio Demo — BSB John';

/** Only local setup creates a demo project; shared Dev/QA need their own chosen QA assignment. */
export async function seedAudioDemo(
  envName: string,
  orgName: string,
  userEmail?: string
): Promise<void> {
  if (envName !== 'local') return;
  if (!userEmail) throw new Error('Audio demo needs a configured local project manager.');
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
  // Resolve BSB by upstream identity first — a catalogue sync may own bba9f…
  // under a suffixed abbreviation while bare 'BSB' names a different bible.
  const [holder] = await db
    .select()
    .from(bibles)
    .where(and(eq(bibles.provider, 'dbl'), eq(bibles.externalId, 'bba9f40183526463-01')))
    .limit(1);
  const [bible] = holder
    ? [holder]
    : await db.select().from(bibles).where(eq(bibles.abbreviation, 'BSB'));
  const [book] = await db.select().from(books).where(eq(books.code, 'JHN'));
  const [target] = await db.select().from(languages).where(eq(languages.langCodeIso6393, 'guj'));
  const [pericopes] = await db.select().from(pericope_sets).where(eq(pericope_sets.name, 'FCBH'));
  const [role] = await db.select().from(roles).where(eq(roles.name, ROLES.PROJECT_MANAGER));
  const missing = [
    ['organization', org],
    [`user ${userEmail}`, user],
    ['BSB bible', bible],
    ['JHN book', book],
    ['Gujarati language', target],
    ['FCBH pericope set', pericopes],
    ['Project Manager role', role],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `Audio demo is local-only and needs seeded prerequisites first — missing: ${missing.join(', ')}. ` +
        'If DATABASE_URL points at a non-local database, this seeder does not apply there.'
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
          name: AUDIO_DEMO_PROJECT_NAME,
          sourceLanguage: bible.languageId,
          sourceBibleId: bible.id,
          targetLanguage: target.id,
          organization: org.id,
          createdBy: user.id,
          status: 'active',
          pericopeSetId: pericopes.id,
          metadata: { seed: AUDIO_DEMO_SEED },
        })
        .returning();
    } else if (project.sourceBibleId === null) {
      // Earlier local seeds predate the milestone hierarchy. Preserve a selected Bible on reruns.
      await tx
        .update(projects)
        .set({ sourceBibleId: bible.id })
        .where(and(eq(projects.id, project.id), isNull(projects.sourceBibleId)));
    }
    let [unit] = await tx
      .select()
      .from(project_units)
      .where(eq(project_units.projectId, project.id))
      .orderBy(project_units.id);
    if (!unit) {
      [unit] = await tx
        .insert(project_units)
        .values({ projectId: project.id, name: project.name })
        .returning();
    } else if (!unit.name) {
      await tx
        .update(project_units)
        .set({ name: project.name })
        .where(and(eq(project_units.id, unit.id), eq(project_units.name, '')));
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const main = async () => {
    // Audio demo is local-only — load the local env-config for the org name
    // and the spec's Project Manager, the same lookup setup.ts performs.
    const { config } = await import('@/db/env-configs/local');
    const { applyDatabaseUrl } = await import('@/db/env-configs/database-url');
    const { findSpecProjectManager } = await import('@/db/seeds/demo');
    const maskedUrl = applyDatabaseUrl(config);
    if (!maskedUrl) {
      console.error('❌  No DATABASE_URL for local — compose injects it inside the container.');
      process.exit(1);
    }
    const pm = findSpecProjectManager(config.demoSpec);
    await seedAudioDemo('local', config.orgName, pm?.email);
  };
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
