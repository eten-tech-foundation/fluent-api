import type { SQL } from 'drizzle-orm';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { bibles } from '@/db/schema';
import { VERSE_AUDIO_CONFLICT_STATUS } from '@/domains/verse-audio/verse-audio.types';
import { ErrorCode } from '@/lib/types';

import { CHAPTER_ASSIGNMENT_STATUS } from '../chapter-assignments.types';
import * as progressRepo from './chapter-assignments-progress.repository';

function sqlText(fragment: SQL): string {
  const parts: string[] = [];
  const walk = (chunk: unknown) => {
    if (chunk == null) return;
    if (typeof chunk === 'string') {
      parts.push(chunk);
      return;
    }
    if (typeof chunk === 'object' && 'value' in chunk && Array.isArray((chunk as any).value)) {
      for (const piece of (chunk as any).value) {
        walk(piece);
      }
      return;
    }
    if ('queryChunks' in (chunk as any) && Array.isArray((chunk as SQL).queryChunks)) {
      for (const piece of (chunk as SQL).queryChunks) {
        walk(piece);
      }
    }
  };
  walk(fragment);
  return parts.join('');
}

function buildProgressSelectChain(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const groupBy = vi.fn().mockReturnValue({ orderBy });
  const where = vi.fn().mockReturnValue({ groupBy });
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where,
    groupBy,
  };
}

const { mockDbSelect } = vi.hoisted(() => {
  const dbSelect = vi.fn<(selection?: unknown) => unknown>();
  return { mockDbSelect: dbSelect };
});

vi.mock('@/db', () => ({
  db: { select: mockDbSelect },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('chapter-assignments-progress.repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hasConflictRollupSql', () => {
    it('correlates verse bible to the assignment bible so other-Bible conflicts are excluded', () => {
      const fragment = progressRepo.hasConflictRollupSql();
      const text = sqlText(fragment);

      expect(text).toContain('bt.bible_id');
      expect(text).toContain('bt.book_id');
      expect(text).toContain('bt.chapter_number');
      expect(text).toContain('var.project_unit_id');
      expect(text).toContain('var.conflict_status');
      expect(text).not.toMatch(/conflict_status\s*=\s*'conflict'/);
      expect(VERSE_AUDIO_CONFLICT_STATUS.CONFLICT).toBe('conflict');
    });

    it('filters strictly on conflict status so clean and resolved recordings are excluded', () => {
      const fragment = progressRepo.hasConflictRollupSql();
      const text = sqlText(fragment);

      expect(text).toMatch(/var\.conflict_status\s*=\s*conflict/);
      expect(text).not.toContain('resolved');
      expect(text).not.toContain('clean');
    });
  });

  describe('findAssignmentsProgress', () => {
    it('groups the Bible primary key when selecting license fields alongside verse counts', async () => {
      const chain = buildProgressSelectChain([]);
      mockDbSelect.mockReturnValue(chain);

      expect(await progressRepo.findAssignmentsProgress({ projectId: 3 })).toEqual({
        ok: true,
        data: [],
      });
      expect(db.select).toHaveBeenCalledWith(
        expect.objectContaining({
          ttsLicenseStatus: expect.anything(),
          textBibleProvider: expect.anything(),
          textBibleExternalId: expect.anything(),
          selectedRecordingProvider: expect.anything(),
          selectedRecordingExternalId: expect.anything(),
        })
      );
      expect(chain.where().groupBy.mock.calls[0]).toContain(bibles.id);
    });

    it('returns an operation failure when the assignment query fails', async () => {
      const chain = buildProgressSelectChain([]);
      chain.where = vi.fn().mockReturnValue({
        groupBy: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockRejectedValue(new Error('database unavailable')),
        }),
      });
      mockDbSelect.mockReturnValue(chain);

      const result = await progressRepo.findAssignmentsProgress({ projectId: 3 });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it('surfaces hasConflict per assignment row from the bible-scoped EXISTS', async () => {
      const rows = [
        {
          assignmentId: 1,
          projectId: 3,
          projectName: 'P',
          projectUnitId: 12,
          bibleId: 9,
          bibleName: 'Target',
          ttsLicenseStatus: 'allowed',
          textBibleProvider: 'dbl',
          textBibleExternalId: 'opaque-text-ID',
          selectedRecordingId: 20,
          selectedRecordingProvider: 'aquifer',
          selectedRecordingExternalId: '20',
          bookId: 1,
          bookCode: 'JHN',
          bookNameEng: 'John',
          chapterNumber: 3,
          status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
          targetLanguage: 'en',
          targetLangCode: 'eng',
          sourceLangCode: 'grc',
          totalVerses: 1,
          completedVerses: 0,
          assignedUserId: 5,
          assignedUserDisplayName: 'u',
          peerCheckerId: null,
          peerCheckerDisplayName: null,
          submittedTime: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          isAiEnabled: false,
          hasClaimConflict: false,
          claimConflictUserId: null,
          hasConflict: true,
        },
        {
          assignmentId: 2,
          projectId: 3,
          projectName: 'P',
          projectUnitId: 12,
          bibleId: 10,
          bibleName: 'Source',
          ttsLicenseStatus: 'unknown',
          textBibleProvider: 'dbl',
          textBibleExternalId: null,
          selectedRecordingId: 88,
          selectedRecordingProvider: 'youversion',
          selectedRecordingExternalId: '88',
          bookId: 1,
          bookCode: 'JHN',
          bookNameEng: 'John',
          chapterNumber: 3,
          status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
          targetLanguage: 'en',
          targetLangCode: 'eng',
          sourceLangCode: 'grc',
          totalVerses: 1,
          completedVerses: 0,
          assignedUserId: 5,
          assignedUserDisplayName: 'u',
          peerCheckerId: null,
          peerCheckerDisplayName: null,
          submittedTime: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          isAiEnabled: false,
          hasClaimConflict: false,
          claimConflictUserId: null,
          hasConflict: false,
        },
      ];

      let selection: Record<string, unknown> | undefined;
      vi.mocked(db.select).mockImplementation((sel) => {
        selection = sel as Record<string, unknown>;
        return buildProgressSelectChain(rows) as any;
      });

      const result = await progressRepo.findAssignmentsProgress({ projectId: 3 });

      expect(selection?.hasConflict).toBeDefined();
      expect(sqlText(selection!.hasConflict as SQL)).toContain('bt.bible_id');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data.map(({ assignmentId }) => assignmentId)).toEqual([1, 2]);
        expect(result.data.find((r) => r.bibleId === 9)).toMatchObject({
          hasConflict: true,
          textBibleKey: 'dbl-opaque-text-ID',
          selectedRecordingKey: 'aq-20',
        });
        expect(result.data.find((r) => r.bibleId === 10)).toMatchObject({
          hasConflict: false,
          textBibleKey: null,
          selectedRecordingKey: 'yv-88',
        });
      }
    });
  });
});
