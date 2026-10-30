import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { ErrorCode } from '@/lib/types';

import * as repo from './draft-comments.repository';
import {
  clearReaction,
  createReply,
  createTopLevelComment,
  getChapterCommentAggregate,
  setReaction,
} from './draft-comments.service';

vi.mock('./draft-comments.repository');
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/db/transaction', () => ({
  runInTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
}));

const writer: AppPolicyUser = {
  id: 5,
  grants: [
    {
      orgId: 1,
      projectId: 1,
      permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
    },
  ],
};

const assignment = {
  assignmentId: 9,
  projectId: 1,
  organizationId: 1,
  projectUnitId: 2,
  bibleId: 3,
  bookId: 40,
  chapterNumber: 1,
  pericopeSetId: 7,
};

function commentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    projectId: 1,
    chapterAssignmentId: 9,
    authorUserId: 5,
    parentCommentId: null,
    bodyKind: 'text' as const,
    bodyText: 'hello',
    emoji: null,
    audioStorageKey: null,
    audioContentType: null,
    audioByteSize: null,
    audioDurationSeconds: null,
    audioContentHash: null,
    anchorKind: 'verse' as const,
    anchorBibleId: 3,
    anchorBookId: 40,
    anchorChapterNumber: 1,
    anchorBibleTextId: 50,
    anchorVerseNumber: 2,
    anchorPericopeSetId: null,
    anchorPericopeNumber: null,
    anchorPericopeTitle: null,
    connectionState: 'connected' as const,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('draft-comments.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repo.findAssignmentContext).mockResolvedValue(assignment);
    vi.mocked(repo.lockAssignmentWriteContext).mockResolvedValue(assignment);
    vi.mocked(repo.findAuthorDisplay).mockResolvedValue({
      id: 5,
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada',
    });
  });

  it('aggregate counts all retained comments and ignores reaction-only presence', async () => {
    vi.mocked(repo.countCommentsForAssignment).mockResolvedValue(4);
    vi.mocked(repo.userHasAuthoredComment).mockResolvedValue(false);

    const result = await getChapterCommentAggregate(writer, 9);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        chapterAssignmentId: 9,
        commentCount: 4,
        currentUserHasCommented: false,
      });
    }
  });

  it('creates top-level verse comment with immutable anchor snapshot', async () => {
    vi.mocked(repo.lockBibleTextById).mockResolvedValue({
      id: 50,
      bibleId: 3,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 2,
    });
    vi.mocked(repo.insertComment).mockResolvedValue(commentRow());

    const result = await createTopLevelComment(writer, 9, {
      anchor: { kind: 'verse', bibleTextId: 50 },
      body: { kind: 'text', text: 'hello' },
    });
    expect(result.ok).toBe(true);
    expect(repo.lockAssignmentWriteContext).toHaveBeenCalledWith(9, expect.anything());
    expect(repo.insertComment).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorKind: 'verse',
        anchorBibleTextId: 50,
        anchorVerseNumber: 2,
        parentCommentId: null,
        bodyKind: 'text',
      }),
      expect.anything()
    );
  });

  it('flattens reply-to-reply onto the root', async () => {
    const root = commentRow({ id: 1, parentCommentId: null });
    const firstReply = commentRow({ id: 2, parentCommentId: 1, bodyText: 'r1' });
    vi.mocked(repo.findCommentById).mockImplementation(async (id: number) => {
      if (id === 2) return firstReply;
      if (id === 1) return root;
      return null as never;
    });
    vi.mocked(repo.insertComment).mockResolvedValue(
      commentRow({ id: 3, parentCommentId: 1, bodyText: 'r2' })
    );

    const result = await createReply(writer, 9, {
      replyToCommentId: 2,
      body: { kind: 'text', text: 'r2' },
    });
    expect(result.ok).toBe(true);
    expect(repo.insertComment).toHaveBeenCalledWith(
      expect.objectContaining({ parentCommentId: 1, bodyText: 'r2' })
    );
  });

  it('setReaction delegates to atomic DB function; clearReaction is explicit', async () => {
    vi.mocked(repo.findCommentById).mockResolvedValue(commentRow());
    vi.mocked(repo.atomicSetReaction).mockResolvedValueOnce('🎉').mockResolvedValueOnce(null);
    vi.mocked(repo.deleteReaction).mockResolvedValue(undefined);

    const set = await setReaction(writer, 9, 100, '🎉');
    expect(set).toEqual({ ok: true, data: { emoji: '🎉' } });
    expect(repo.atomicSetReaction).toHaveBeenCalledWith(100, 5, '🎉', expect.anything());

    const toggle = await setReaction(writer, 9, 100, '🎉');
    expect(toggle).toEqual({ ok: true, data: { emoji: null } });

    const cleared = await clearReaction(writer, 9, 100);
    expect(cleared).toEqual({ ok: true, data: { cleared: true } });
  });

  it('denies write without comment:write even with content:update', async () => {
    const translatorOnly: AppPolicyUser = {
      id: 5,
      grants: [
        {
          orgId: 1,
          projectId: 1,
          permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.CONTENT_UPDATE]),
        },
      ],
    };
    const result = await createTopLevelComment(translatorOnly, 9, {
      anchor: { kind: 'verse', bibleTextId: 50 },
      body: { kind: 'text', text: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.FORBIDDEN);
  });

  it('creates pericope comment snapshotting public wire id 6_1', async () => {
    vi.mocked(repo.lockPericopeMembership).mockResolvedValue({
      pericopeSetId: 7,
      bookId: 40,
      chapterNumber: 1,
      pericopeNumber: '6_1',
      pericopeTitle: null,
    });
    vi.mocked(repo.insertComment).mockResolvedValue(
      commentRow({
        anchorKind: 'pericope',
        anchorBibleTextId: null,
        anchorVerseNumber: null,
        anchorPericopeSetId: 7,
        anchorPericopeNumber: '6_1',
        bodyKind: 'text',
        bodyText: 'on 6_1',
      })
    );

    const result = await createTopLevelComment(writer, 9, {
      anchor: { kind: 'pericope', pericopeNumber: '6_1' },
      body: { kind: 'text', text: 'on 6_1' },
    });
    expect(result.ok).toBe(true);
    expect(repo.lockPericopeMembership).toHaveBeenCalledWith(7, 40, 1, '6_1', expect.anything());
    expect(repo.insertComment).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorKind: 'pericope',
        anchorPericopeNumber: '6_1',
        anchorPericopeSetId: 7,
      }),
      expect.anything()
    );
    if (result.ok) {
      expect(result.data.anchor.pericopeNumber).toBe('6_1');
    }
  });

  it('rejects unknown/mismatched public pericope id before insert', async () => {
    vi.mocked(repo.lockPericopeMembership).mockResolvedValue(null);
    const result = await createTopLevelComment(writer, 9, {
      anchor: { kind: 'pericope', pericopeNumber: '1' },
      body: { kind: 'text', text: 'nope' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_REFERENCE);
    expect(repo.insertComment).not.toHaveBeenCalled();
  });

  it('denies pericope create when assignment is not readable (wrong project grant)', async () => {
    const otherProject: AppPolicyUser = {
      id: 5,
      grants: [
        {
          orgId: 1,
          projectId: 99,
          permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
        },
      ],
    };
    const result = await createTopLevelComment(otherProject, 9, {
      anchor: { kind: 'pericope', pericopeNumber: '6_1' },
      body: { kind: 'text', text: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
    expect(repo.findPericopeMembership).not.toHaveBeenCalled();
  });
});
