import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppPolicyUser } from '@/lib/types';

import { runInTransaction } from '@/db/transaction';
import { deleteVerseAudio, isAudioStorageAvailable, uploadVerseAudio } from '@/lib/audio-storage';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorCode } from '@/lib/types';

import { createAudioComment } from './draft-comments.audio.service';
import * as repo from './draft-comments.repository';
import { MAX_COMMENT_AUDIO_BYTES } from './draft-comments.types';

vi.mock('./draft-comments.repository');
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/audio-storage', () => ({
  isAudioStorageAvailable: vi.fn(() => true),
  uploadVerseAudio: vi.fn(async () => {}),
  deleteVerseAudio: vi.fn(async () => {}),
  generateAudioDownloadUrl: vi.fn(async (key: string) => `https://r2.example/${key}`),
}));
vi.mock('@/db/transaction', () => ({
  runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
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

const audioBytes = Buffer.from('fake-audio-bytes');
const contentHash = createHash('sha256').update(audioBytes).digest('hex');
const COMMENT_KEY_RE = new RegExp(`^comments/1/[0-9a-f-]{36}/${contentHash}$`);

function commentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    projectId: 1,
    chapterAssignmentId: 9,
    authorUserId: 5,
    parentCommentId: null,
    bodyKind: 'audio' as const,
    bodyText: null,
    emoji: null,
    audioStorageKey: `comments/1/00000000-0000-0000-0000-000000000001/${contentHash}`,
    audioContentType: 'audio/mp4',
    audioByteSize: audioBytes.length,
    audioDurationSeconds: 1.5,
    audioContentHash: contentHash,
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

function file(
  overrides: Partial<{ data: Buffer; contentType: string; durationSeconds: number | null }> = {}
) {
  return {
    data: audioBytes,
    contentType: 'audio/mp4',
    durationSeconds: 1.5 as number | null,
    ...overrides,
  };
}

describe('createAudioComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runInTransaction).mockImplementation(async (work) => work({} as never));
    vi.mocked(isAudioStorageAvailable).mockReturnValue(true);
    vi.mocked(uploadVerseAudio).mockResolvedValue(undefined);
    vi.mocked(deleteVerseAudio).mockResolvedValue(undefined);
    vi.mocked(repo.findAssignmentContext).mockResolvedValue(assignment);
    vi.mocked(repo.lockAssignmentWriteContext).mockResolvedValue(assignment);
    vi.mocked(repo.findAuthorDisplay).mockResolvedValue({
      id: 5,
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada',
    });
    const bibleText = {
      id: 50,
      bibleId: 3,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 2,
    };
    vi.mocked(repo.findBibleTextById).mockResolvedValue(bibleText);
    vi.mocked(repo.lockBibleTextById).mockResolvedValue(bibleText);
    vi.mocked(repo.lockCommentById).mockImplementation(async (id: number) =>
      repo.findCommentById(id)
    );
    vi.mocked(repo.lockPericopeMembership).mockResolvedValue(null as never);
    vi.mocked(repo.lockPublicPericopeIdentity).mockResolvedValue(undefined as never);
    vi.mocked(repo.insertComment).mockImplementation(async (values) =>
      commentRow({
        id: 100,
        parentCommentId: values.parentCommentId ?? null,
        connectionState: values.connectionState,
        anchorKind: values.anchorKind,
        anchorBibleId: values.anchorBibleId,
        anchorBookId: values.anchorBookId,
        anchorChapterNumber: values.anchorChapterNumber,
        anchorBibleTextId: values.anchorBibleTextId,
        anchorVerseNumber: values.anchorVerseNumber,
        anchorPericopeSetId: values.anchorPericopeSetId,
        anchorPericopeNumber: values.anchorPericopeNumber,
        anchorPericopeTitle: values.anchorPericopeTitle,
        audioStorageKey: values.audioStorageKey,
      })
    );
  });

  it('creates a root audio comment with session author and null parent', async () => {
    const result = await createAudioComment(writer, 9, { kind: 'verse', bibleTextId: 50 }, file());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.author.userId).toBe(5);
      expect(result.data.parentCommentId).toBeNull();
      expect(result.data.bodyKind).toBe('audio');
    }
    expect(uploadVerseAudio).toHaveBeenCalledWith(
      expect.stringMatching(COMMENT_KEY_RE),
      audioBytes,
      'audio/mp4'
    );
    expect(repo.insertComment).toHaveBeenCalledWith(
      expect.objectContaining({
        parentCommentId: null,
        authorUserId: 5,
        bodyKind: 'audio',
        connectionState: 'connected',
        audioStorageKey: expect.stringMatching(COMMENT_KEY_RE),
      }),
      expect.anything()
    );
  });

  it('uploads before the short write transaction', async () => {
    const order: string[] = [];
    vi.mocked(uploadVerseAudio).mockImplementation(async () => {
      order.push('upload');
    });
    vi.mocked(runInTransaction).mockImplementation(async (work) => {
      order.push('tx');
      return work({} as never);
    });
    await createAudioComment(writer, 9, { kind: 'verse', bibleTextId: 50 }, file());
    expect(order).toEqual(['upload', 'tx']);
  });

  it('replies to a root with parentCommentId = root id and inherits snapshot', async () => {
    const root = commentRow({
      id: 10,
      parentCommentId: null,
      connectionState: 'unconnected',
      anchorBibleTextId: 50,
      anchorVerseNumber: 2,
    });
    vi.mocked(repo.findCommentById).mockResolvedValue(root);

    const result = await createAudioComment(
      writer,
      9,
      { kind: 'verse', bibleTextId: 999 },
      file(),
      null,
      10
    );
    expect(result.ok).toBe(true);
    expect(uploadVerseAudio).toHaveBeenCalled();
    expect(repo.insertComment).toHaveBeenCalledWith(
      expect.objectContaining({
        parentCommentId: 10,
        authorUserId: 5,
        connectionState: 'unconnected',
        anchorBibleTextId: 50,
        anchorVerseNumber: 2,
      }),
      expect.anything()
    );
  });

  it('flattens reply-to-reply onto the root id', async () => {
    const root = commentRow({ id: 1, parentCommentId: null, connectionState: 'connected' });
    const firstReply = commentRow({ id: 2, parentCommentId: 1, bodyKind: 'text' });
    vi.mocked(repo.findCommentById).mockImplementation(async (id: number) => {
      if (id === 2) return firstReply;
      if (id === 1) return root;
      return null as never;
    });

    const result = await createAudioComment(writer, 9, null, file(), null, 2);
    expect(result.ok).toBe(true);
    expect(repo.insertComment).toHaveBeenCalledWith(
      expect.objectContaining({ parentCommentId: 1, authorUserId: 5 }),
      expect.anything()
    );
  });

  it('denies unknown / cross-chapter / cross-project targets before storage', async () => {
    vi.mocked(repo.findCommentById).mockResolvedValueOnce(null as never);
    const unknown = await createAudioComment(writer, 9, null, file(), null, 404);
    expect(unknown.ok).toBe(false);
    expect(uploadVerseAudio).not.toHaveBeenCalled();

    vi.mocked(repo.findCommentById).mockResolvedValueOnce(
      commentRow({ id: 3, chapterAssignmentId: 99 })
    );
    await createAudioComment(writer, 9, null, file(), null, 3);
    expect(uploadVerseAudio).not.toHaveBeenCalled();

    vi.mocked(repo.findCommentById).mockResolvedValueOnce(commentRow({ id: 4, projectId: 99 }));
    await createAudioComment(writer, 9, null, file(), null, 4);
    expect(uploadVerseAudio).not.toHaveBeenCalled();
  });

  it('denies missing / revoked write before storage', async () => {
    const noWrite: AppPolicyUser = {
      id: 5,
      grants: [
        {
          orgId: 1,
          projectId: 1,
          permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.CONTENT_UPDATE]),
        },
      ],
    };
    const forbidden = await createAudioComment(
      noWrite,
      9,
      { kind: 'verse', bibleTextId: 50 },
      file()
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe(ErrorCode.FORBIDDEN);
    expect(uploadVerseAudio).not.toHaveBeenCalled();
  });

  it('rejects empty, oversize, bad MIME, and non-finite duration before storage', async () => {
    await createAudioComment(
      writer,
      9,
      { kind: 'verse', bibleTextId: 50 },
      file({ data: Buffer.alloc(0) })
    );
    await createAudioComment(
      writer,
      9,
      { kind: 'verse', bibleTextId: 50 },
      file({ data: Buffer.alloc(MAX_COMMENT_AUDIO_BYTES + 1) })
    );
    await createAudioComment(
      writer,
      9,
      { kind: 'verse', bibleTextId: 50 },
      file({ contentType: 'video/mp4' })
    );
    for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1, 30 * 60 + 1]) {
      await createAudioComment(
        writer,
        9,
        { kind: 'verse', bibleTextId: 50 },
        file({ durationSeconds })
      );
    }
    expect(uploadVerseAudio).not.toHaveBeenCalled();
  });

  it('returns unavailable on storage failure without insert or delete', async () => {
    vi.mocked(uploadVerseAudio).mockRejectedValue(new Error('r2 down'));
    const result = await createAudioComment(writer, 9, { kind: 'verse', bibleTextId: 50 }, file());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.COMMENT_AUDIO_STORAGE_UNAVAILABLE);
    expect(repo.insertComment).not.toHaveBeenCalled();
    expect(deleteVerseAudio).not.toHaveBeenCalled();
  });

  it('rejects and cleans upload when source vanishes before locked revalidation', async () => {
    vi.mocked(uploadVerseAudio).mockImplementation(async () => {
      vi.mocked(repo.lockBibleTextById).mockResolvedValue(null as never);
    });
    const result = await createAudioComment(writer, 9, { kind: 'verse', bibleTextId: 50 }, file());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_REFERENCE);
    expect(repo.lockBibleTextById).toHaveBeenCalled();
    expect(repo.insertComment).not.toHaveBeenCalled();
    expect(deleteVerseAudio).toHaveBeenCalledWith(expect.stringMatching(COMMENT_KEY_RE));
  });

  it('rejects and cleans upload when reply root vanishes before locked revalidation', async () => {
    const root = commentRow({ id: 10, parentCommentId: null });
    vi.mocked(repo.findCommentById).mockResolvedValue(root);
    vi.mocked(repo.lockCommentById).mockResolvedValue(root);
    vi.mocked(uploadVerseAudio).mockImplementation(async () => {
      vi.mocked(repo.lockCommentById).mockResolvedValue(null as never);
    });
    const result = await createAudioComment(writer, 9, null, file(), null, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.CHAPTER_COMMENT_NOT_FOUND);
    expect(repo.lockCommentById).toHaveBeenCalled();
    expect(repo.insertComment).not.toHaveBeenCalled();
    expect(deleteVerseAudio).toHaveBeenCalledWith(expect.stringMatching(COMMENT_KEY_RE));
  });

  it('uses locked assignment context for the short write (not unlocked SELECT)', async () => {
    await createAudioComment(writer, 9, { kind: 'verse', bibleTextId: 50 }, file());
    expect(repo.lockAssignmentWriteContext).toHaveBeenCalled();
    expect(repo.lockBibleTextById).toHaveBeenCalledWith(50, expect.anything());
  });

  it('cleans only the attempt key when the short write throws after upload', async () => {
    vi.mocked(repo.insertComment).mockRejectedValue(new Error('db blew up'));
    const result = await createAudioComment(writer, 9, { kind: 'verse', bibleTextId: 50 }, file());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(deleteVerseAudio).toHaveBeenCalledWith(expect.stringMatching(COMMENT_KEY_RE));
    expect(deleteVerseAudio).not.toHaveBeenCalledWith(expect.stringContaining('pending'));
  });

  it('does not delete committed audio when post-commit author/map fails', async () => {
    vi.mocked(repo.findAuthorDisplay).mockRejectedValue(new Error('author lookup failed'));
    const result = await createAudioComment(writer, 9, { kind: 'verse', bibleTextId: 50 }, file());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(repo.insertComment).toHaveBeenCalled();
    expect(deleteVerseAudio).not.toHaveBeenCalled();
  });

  it('preserves attempt object when callback ok then outer commit ack is lost', async () => {
    vi.mocked(runInTransaction).mockImplementation(async (work) => {
      const result = await work({} as never);
      if (result.ok) throw new Error('lost-commit-ack');
      return result;
    });

    const result = await createAudioComment(writer, 9, { kind: 'verse', bibleTextId: 50 }, file());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(uploadVerseAudio).toHaveBeenCalled();
    expect(repo.insertComment).toHaveBeenCalled();
    expect(deleteVerseAudio).not.toHaveBeenCalled();
  });
});
