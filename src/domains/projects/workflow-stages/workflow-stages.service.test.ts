import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { project_workflow_stages } from '@/db/schema';
import {
  installNextCatalogueWatermarkFunction,
  seedCatalogueWatermarkSingleton,
} from '@/db/testing/create-catalogue-schema';
import { ErrorCode } from '@/lib/types';

import {
  addStage,
  deleteStage,
  getWorkflowStages,
  renameStage,
  reorderStages,
  seedDefaultStages,
} from './workflow-stages.service';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const PROJECT_ID = 1;

async function seedBaseEntities() {
  await database.insert(schema.organizations).values({ id: 1, name: 'Test Organization' });
  await database.insert(schema.languages).values([
    { id: 1, langName: 'English' },
    { id: 2, langName: 'Spanish' },
  ]);
  await database.insert(schema.books).values([{ id: 41, code: 'MRK', eng_display_name: 'Mark' }]);
  await database.insert(schema.bibles).values({
    id: 1,
    languageId: 1,
    name: 'Source Bible',
    abbreviation: 'SRC',
    provider: 'dbl',
  });
  await database.insert(schema.users).values({
    id: 1,
    username: 'translator',
    email: 'user@example.com',
  });
}

async function seedProject(id = PROJECT_ID) {
  await database.insert(schema.projects).values({
    id,
    name: `Test Project ${id}`,
    organization: 1,
    sourceLanguage: 1,
    targetLanguage: 2,
    sourceBibleId: 1,
  });
}

describe('workflow stages service (PGlite integration)', () => {
  beforeAll(async () => {
    await installNextCatalogueWatermarkFunction(client);
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema)
    );
    await client.exec(statements.join('\n'));
    await seedCatalogueWatermarkSingleton(client);
    await seedBaseEntities();
  });

  beforeEach(async () => {
    await database.delete(schema.chapter_assignment_status_history);
    await database.delete(schema.chapter_assignments);
    await database.delete(schema.project_unit_bible_books);
    await database.delete(schema.project_units);
    await database.delete(schema.project_workflow_stages);
    await database.delete(schema.projects);
  });

  describe('getWorkflowStages', () => {
    it('returns WORKFLOW_NOT_CONFIGURED when no workflow stages exist for project', async () => {
      await seedProject();
      const result = await getWorkflowStages(PROJECT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_NOT_CONFIGURED);
      }
    });

    it('returns all default stages ordered by position when seeded', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const result = await getWorkflowStages(PROJECT_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(8);
        expect(result.data.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(result.data[0].id).toBe('not_started');
        expect(result.data[0].isFixed).toBe(true);
        expect(result.data[7].id).toBe('complete');
        expect(result.data[7].isFixed).toBe(true);
      }
    });
  });

  describe('addStage', () => {
    it('shifts Complete stage position and inserts new custom stage at complete old slot', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const result = await addStage(PROJECT_ID, 'Quality Assurance');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.label).toBe('Quality Assurance');
        expect(result.data.position).toBe(7);
        expect(result.data.isFixed).toBe(false);
      }

      // Check real DB positions to verify complete shifted to 8 and unique index is respected
      const allRows = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID))
        .orderBy(asc(project_workflow_stages.position));

      expect(allRows).toHaveLength(9);
      expect(allRows[7].displayName).toBe('Quality Assurance');
      expect(allRows[7].position).toBe(7);
      expect(allRows[8].defaultName).toBe('complete');
      expect(allRows[8].position).toBe(8);
    });

    it('auto-suffixes "New Stage" on duplicate default name without constraint violation', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const first = await addStage(PROJECT_ID, 'New Stage');
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.data.label).toBe('New Stage');
      }

      const second = await addStage(PROJECT_ID, 'New Stage');
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.data.label).toBe('New Stage 2');
      }

      const third = await addStage(PROJECT_ID, 'New Stage');
      expect(third.ok).toBe(true);
      if (third.ok) {
        expect(third.data.label).toBe('New Stage 3');
      }
    });

    it('rejects adding a stage with an explicit duplicate custom name', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const result = await addStage(PROJECT_ID, 'Community Review');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_DUPLICATE_NAME);
      }
    });

    it('rejects adding a stage with a duplicate custom name even with surrounding whitespace', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const result = await addStage(PROJECT_ID, '  Community Review  ');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_DUPLICATE_NAME);
      }
    });

    it('rejects adding a stage when 10 configurable stages limit is reached', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      // Default has 6 configurable stages. Add 4 to reach 10 configurable stages.
      for (let i = 1; i <= 4; i++) {
        const res = await addStage(PROJECT_ID, `Custom Stage ${i}`);
        expect(res.ok).toBe(true);
      }

      // 11th configurable stage must be rejected
      const overflow = await addStage(PROJECT_ID, 'Custom Stage 5');
      expect(overflow.ok).toBe(false);
      if (!overflow.ok) {
        expect(overflow.error.code).toBe(ErrorCode.WORKFLOW_STAGE_LIMIT_REACHED);
      }
    });

    it('rejects adding a stage when Complete stage has been reached in status history', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      // Create milestone, assignment, and status history reaching 'complete'
      await database.insert(schema.project_units).values({
        id: 11,
        projectId: PROJECT_ID,
        name: 'Milestone 1',
      });
      await database.insert(schema.chapter_assignments).values({
        id: 101,
        projectUnitId: 11,
        bibleId: 1,
        bookId: 41,
        chapterNumber: 1,
        status: 'complete',
      });
      await database.insert(schema.chapter_assignment_status_history).values({
        chapterAssignmentId: 101,
        status: 'complete',
      });

      const result = await addStage(PROJECT_ID, 'Post Complete Check');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_LOCKED);
      }
    });
  });

  describe('renameStage', () => {
    it('renames an unlocked configurable stage', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const rows = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID));
      const communityStage = rows.find((r) => r.defaultName === 'community_review')!;

      const result = await renameStage(PROJECT_ID, communityStage.id, 'Village Check');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.label).toBe('Village Check');
      }
    });

    it('rejects renaming bookend stages (not_started, complete)', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const rows = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID));
      const startStage = rows.find((r) => r.defaultName === 'not_started')!;

      const result = await renameStage(PROJECT_ID, startStage.id, 'Beginning');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_FIXED);
      }
    });

    it('rejects renaming to duplicate name', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const rows = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID));
      const communityStage = rows.find((r) => r.defaultName === 'community_review')!;

      const result = await renameStage(PROJECT_ID, communityStage.id, 'Drafting');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_DUPLICATE_NAME);
      }
    });

    it('rejects renaming to duplicate name even with surrounding whitespace', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const rows = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID));
      const communityStage = rows.find((r) => r.defaultName === 'community_review')!;

      const result = await renameStage(PROJECT_ID, communityStage.id, '  Drafting  ');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_DUPLICATE_NAME);
      }
    });
  });

  describe('reorderStages (two-pass parking logic & unique constraints)', () => {
    it('successfully swaps two unlocked configurable stages using parking pass', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const stages = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID))
        .orderBy(asc(project_workflow_stages.position));

      // Swap position 3 (community_review) and position 4 (linguist_check)
      const reorderedIds = stages.map((s) => s.id);
      const temp = reorderedIds[3];
      reorderedIds[3] = reorderedIds[4];
      reorderedIds[4] = temp;

      const result = await reorderStages(PROJECT_ID, reorderedIds);
      expect(result.ok).toBe(true);

      const updated = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID))
        .orderBy(asc(project_workflow_stages.position));

      expect(updated[3].defaultName).toBe('linguist_check');
      expect(updated[4].defaultName).toBe('community_review');
    });

    it('rejects moving fixed stages', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const stages = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID))
        .orderBy(asc(project_workflow_stages.position));

      const reorderedIds = stages.map((s) => s.id);
      // Attempt to move not_started (index 0) to index 1
      const temp = reorderedIds[0];
      reorderedIds[0] = reorderedIds[1];
      reorderedIds[1] = temp;

      const result = await reorderStages(PROJECT_ID, reorderedIds);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_FIXED);
      }
    });

    it('rejects incomplete stage lists', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const result = await reorderStages(PROJECT_ID, [1, 2, 3]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_INVALID_LIST);
      }
    });
  });

  describe('deleteStage (gap closure) and stage locking', () => {
    it('deletes an unlocked configurable stage and closes the position gap', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const stages = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID))
        .orderBy(asc(project_workflow_stages.position));

      const target = stages.find((s) => s.defaultName === 'theological_check')!;
      const result = await deleteStage(PROJECT_ID, target.id);
      expect(result.ok).toBe(true);

      const remaining = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID))
        .orderBy(asc(project_workflow_stages.position));

      expect(remaining).toHaveLength(7);
      expect(remaining.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(remaining.find((s) => s.defaultName === 'theological_check')).toBeUndefined();
    });

    it('rejects deleting fixed stages', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      const stages = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID));

      const draftingStage = stages.find((s) => s.defaultName === 'draft')!;
      const result = await deleteStage(PROJECT_ID, draftingStage.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_FIXED);
      }
    });

    it('locks stages reached in status history and prevents deletion and reordering', async () => {
      await seedProject();
      await seedDefaultStages(PROJECT_ID);

      // Create milestone, assignment, and status history reaching 'community_review'
      await database.insert(schema.project_units).values({
        id: 10,
        projectId: PROJECT_ID,
        name: 'Milestone 1',
      });
      await database.insert(schema.chapter_assignments).values({
        id: 100,
        projectUnitId: 10,
        bibleId: 1,
        bookId: 41,
        chapterNumber: 1,
        status: 'community_review',
      });
      await database.insert(schema.chapter_assignment_status_history).values({
        chapterAssignmentId: 100,
        status: 'community_review',
      });

      const stages = await database
        .select()
        .from(project_workflow_stages)
        .where(eq(project_workflow_stages.projectId, PROJECT_ID))
        .orderBy(asc(project_workflow_stages.position));

      const communityStage = stages.find((s) => s.defaultName === 'community_review')!;
      const linguistStage = stages.find((s) => s.defaultName === 'linguist_check')!;

      // Deleting reached stage must fail with WORKFLOW_STAGE_LOCKED
      const deleteResult = await deleteStage(PROJECT_ID, communityStage.id);
      expect(deleteResult.ok).toBe(false);
      if (!deleteResult.ok) {
        expect(deleteResult.error.code).toBe(ErrorCode.WORKFLOW_STAGE_LOCKED);
      }

      // Reordering locked stage must fail with WORKFLOW_STAGE_LOCKED
      const reorderedIds = stages.map((s) => s.id);
      const temp = reorderedIds[3];
      reorderedIds[3] = reorderedIds[4];
      reorderedIds[4] = temp;

      const reorderResult = await reorderStages(PROJECT_ID, reorderedIds);
      expect(reorderResult.ok).toBe(false);
      if (!reorderResult.ok) {
        expect(reorderResult.error.code).toBe(ErrorCode.WORKFLOW_STAGE_LOCKED);
      }

      // Unreached later stage (linguist_check) can still be deleted
      const deleteUnlockedResult = await deleteStage(PROJECT_ID, linguistStage.id);
      expect(deleteUnlockedResult.ok).toBe(true);
    });
  });
});
