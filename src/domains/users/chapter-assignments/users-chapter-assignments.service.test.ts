import { describe, expect, it } from 'vitest';

import type { ChapterAssignmentProgressInfo } from '@/domains/chapter-assignments/chapter-assignments.types';

import { toResponse } from './users-chapter-assignments.service';

/**
 * A complete ChapterAssignmentProgressInfo with sensible defaults; override via
 * the partial argument. Mirrors the shape produced by the repository query.
 */
const makeProgressInfo = (
  over: Partial<ChapterAssignmentProgressInfo> = {}
): ChapterAssignmentProgressInfo => ({
  assignmentId: 1,
  projectId: 1,
  projectName: 'Test project',
  projectUnitId: 1,
  bibleId: 1,
  bibleName: 'Test Bible',
  bookId: 3,
  bookCode: 'LEV',
  bookNameEng: 'Leviticus',
  chapterNumber: 2,
  status: 'draft',
  // `targetLanguage` is the human display NAME; `targetLangCode` is the ISO code.
  targetLanguage: 'English',
  targetLangCode: 'eng',
  sourceLangCode: 'eng',
  totalVerses: 4,
  completedVerses: 0,
  assignedUserId: 2,
  assignedUserDisplayName: 'translator',
  peerCheckerId: null,
  peerCheckerDisplayName: null,
  submittedTime: null,
  createdAt: null,
  updatedAt: null,
  isAiEnabled: false,
  hasClaimConflict: false,
  claimConflictUserId: null,
  hasConflict: false,
  ...over,
});

describe('toResponse', () => {
  it('exposes the target ISO 639-3 code as targetLangCode (BUG #2 regression)', () => {
    // The repeated-words check sends targetLangCode as greek-room's lang_code;
    // greek-room keys its legitimate-duplicate whitelist on the ISO code, so the
    // API must surface the code (not just the display name). See phase-04 manual
    // smoke (BUG #2, 2026-06-23).
    const response = toResponse(
      makeProgressInfo({ targetLanguage: 'English', targetLangCode: 'eng' })
    );
    expect(response.targetLangCode).toBe('eng');
    // The display name still flows through its own field.
    expect(response.targetLanguage).toBe('English');
  });

  it('falls back to "" when the target ISO code is null', () => {
    const response = toResponse(makeProgressInfo({ targetLangCode: null }));
    expect(response.targetLangCode).toBe('');
  });

  it('propagates claim conflict fields from repository progress rows', () => {
    const response = toResponse(
      makeProgressInfo({ hasClaimConflict: true, claimConflictUserId: 99 })
    );
    expect(response.hasClaimConflict).toBe(true);
    expect(response.claimConflictUserId).toBe(99);
  });
});
