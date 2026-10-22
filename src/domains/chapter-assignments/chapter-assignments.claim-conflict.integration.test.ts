import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

import * as repo from './chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schemaMod = await import('@/db/schema');
  const client = new PGlite();
  return { client, database: drizzle(client, { schema: schemaMod }) };
});

vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

describe('flagClaimConflict SQL CAS (PGlite)', () => {
  beforeAll(async () => {
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({
        chapter_assignments: schema.chapter_assignments,
        project_units: schema.project_units,
        milestoneTypeEnum: schema.milestoneTypeEnum,
        projectStatusEnum: schema.projectStatusEnum,
        projects: schema.projects,
        projectAssignmentStatusEnum: schema.projectAssignmentStatusEnum,
        organizations: schema.organizations,
        languages: schema.languages,
        scriptDirectionEnum: schema.scriptDirectionEnum,
        bibles: schema.bibles,
        bibleProviderEnum: schema.bibleProviderEnum,
        bible_provider_resources: schema.bible_provider_resources,
        resourceProviderEnum: schema.resourceProviderEnum,
        ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
        books: schema.books,
        users: schema.users,
        userStatusEnum: schema.userStatusEnum,
        authUser: schema.authUser,
        pericope_sets: schema.pericope_sets,
      })
    );
    await client.exec(statements.join('\n'));

    await database.insert(schema.organizations).values({ id: 1, name: 'Org' });
    await database.insert(schema.languages).values({ id: 1, langName: 'English' });
    await database.insert(schema.books).values({ id: 1, code: 'GEN', eng_display_name: 'Genesis' });
    await database.insert(schema.bibles).values({
      id: 1,
      languageId: 1,
      name: 'Test Bible',
      abbreviation: 'TST',
      provider: 'dbl',
    });
    await database.insert(schema.users).values([
      { id: 5, username: 'claimant', email: 'claimant@example.com' },
      { id: 7, username: 'assignee', email: 'assignee@example.com' },
      { id: 11, username: 'later', email: 'later@example.com' },
      { id: 88, username: 'peer', email: 'peer@example.com' },
    ]);
    await database.insert(schema.projects).values({
      id: 1,
      name: 'Project',
      sourceLanguage: 1,
      targetLanguage: 1,
      organization: 1,
    });
    await database.insert(schema.project_units).values({
      id: 10,
      projectId: 1,
      name: 'Unit',
      type: 'text',
    });
  }, 30_000);

  beforeEach(async () => {
    await database.delete(schema.chapter_assignments);
    await database.insert(schema.chapter_assignments).values({
      id: 1,
      projectUnitId: 10,
      bibleId: 1,
      bookId: 1,
      chapterNumber: 1,
      assignedUserId: 7,
      peerCheckerId: 88,
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      hasClaimConflict: false,
      claimConflictUserId: null,
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it('flags rival DRAFT with first-loser latch on claimConflictUserId; assignee and peer preserved', async () => {
    const first = await database.transaction((tx) => repo.flagClaimConflict(1, 5, tx));
    expect(first).toMatchObject({
      assignedUserId: 7,
      peerCheckerId: 88,
      hasClaimConflict: true,
      claimConflictUserId: 5,
    });

    const second = await database.transaction((tx) => repo.flagClaimConflict(1, 11, tx));
    expect(second).toMatchObject({
      assignedUserId: 7,
      peerCheckerId: 88,
      hasClaimConflict: true,
      claimConflictUserId: 5,
    });

    const [row] = await database
      .select()
      .from(schema.chapter_assignments)
      .where(eq(schema.chapter_assignments.id, 1));
    expect(row.assignedUserId).toBe(7);
    expect(row.peerCheckerId).toBe(88);
    expect(row.claimConflictUserId).toBe(5);
  });

  it('flags a rival who has left DRAFT without changing assignee or status', async () => {
    await database
      .update(schema.chapter_assignments)
      .set({ status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK })
      .where(eq(schema.chapter_assignments.id, 1));

    const flagged = await database.transaction((tx) => repo.flagClaimConflict(1, 5, tx));
    expect(flagged?.hasClaimConflict).toBe(true);
    expect(flagged?.claimConflictUserId).toBe(5);
    expect(flagged?.assignedUserId).toBe(7);
    expect(flagged?.status).toBe(CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);

    const [row] = await database
      .select()
      .from(schema.chapter_assignments)
      .where(eq(schema.chapter_assignments.id, 1));
    expect(row.hasClaimConflict).toBe(true);
    expect(row.claimConflictUserId).toBe(5);
    expect(row.assignedUserId).toBe(7);
    expect(row.status).toBe(CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
  });

  it('does not flag when PM reassigned the row to the claimant', async () => {
    await database
      .update(schema.chapter_assignments)
      .set({ assignedUserId: 5 })
      .where(eq(schema.chapter_assignments.id, 1));

    const flagged = await database.transaction((tx) => repo.flagClaimConflict(1, 5, tx));
    expect(flagged).toBeNull();

    const [row] = await database
      .select()
      .from(schema.chapter_assignments)
      .where(eq(schema.chapter_assignments.id, 1));
    expect(row.hasClaimConflict).toBe(false);
    expect(row.claimConflictUserId).toBeNull();
    expect(row.assignedUserId).toBe(5);
    expect(row.peerCheckerId).toBe(88);
  });

  it('returns null after delete (no unpersisted UPDATE success)', async () => {
    await database.delete(schema.chapter_assignments).where(eq(schema.chapter_assignments.id, 1));

    const flagged = await database.transaction((tx) => repo.flagClaimConflict(1, 5, tx));
    expect(flagged).toBeNull();
  });

  it('does not flag when the rival assignment is complete', async () => {
    await database
      .update(schema.chapter_assignments)
      .set({ status: CHAPTER_ASSIGNMENT_STATUS.COMPLETE })
      .where(eq(schema.chapter_assignments.id, 1));

    const flagged = await database.transaction((tx) => repo.flagClaimConflict(1, 5, tx));
    expect(flagged).toBeNull();

    const [row] = await database
      .select()
      .from(schema.chapter_assignments)
      .where(eq(schema.chapter_assignments.id, 1));
    expect(row.hasClaimConflict).toBe(false);
    expect(row.claimConflictUserId).toBeNull();
    expect(row.status).toBe(CHAPTER_ASSIGNMENT_STATUS.COMPLETE);
  });
});
