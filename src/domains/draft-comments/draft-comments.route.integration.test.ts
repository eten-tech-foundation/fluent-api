import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import * as draftCommentsService from './draft-comments.service';

import '@/domains/draft-comments/draft-comments.route';

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() }, handler: vi.fn() },
}));
vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    returning: vi.fn().mockResolvedValue([]),
  };
  return {
    db: {
      select: vi.fn(() => mockQueryBuilder),
      insert: vi.fn(() => mockQueryBuilder),
      update: vi.fn(() => mockQueryBuilder),
      delete: vi.fn(() => mockQueryBuilder),
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/users/users.service', () => ({ getUserByEmail: vi.fn() }));
vi.mock('@/domains/user-roles/user-roles.repository', () => ({ findGrantsByUserId: vi.fn() }));
vi.mock('./draft-comments.service', () => ({
  listChapterComments: vi.fn(),
  getChapterCommentAggregate: vi.fn(),
  createTopLevelComment: vi.fn(),
  createReply: vi.fn(),
  setReaction: vi.fn(),
  clearReaction: vi.fn(),
  createAudioComment: vi.fn(),
  resolveCommentAssignmentScope: vi.fn(),
}));

const APP_USER = {
  id: 1,
  email: 'observer@example.com',
  username: 'observer',
  firstName: null,
  lastName: null,
  createdBy: null,
  status: 'verified' as const,
  createdAt: null,
  updatedAt: null,
  lastActiveOrgId: null,
};

function asAuthenticatedUser(
  grants: Array<{ orgId: number | null; projectId: number | null; permissions: Set<string> }>
) {
  const now = new Date();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 's1',
      userId: 'auth-user-1',
      token: 'test-session-token',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 1e9),
    },
    user: {
      id: 'auth-user-1',
      name: APP_USER.username,
      email: APP_USER.email,
      emailVerified: true,
      banned: false,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  vi.mocked(getUserByEmail).mockResolvedValue(ok(APP_USER));
  vi.mocked(findGrantsByUserId).mockResolvedValue(ok(grants as never));
}

describe('draft-comments routes auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(draftCommentsService.resolveCommentAssignmentScope).mockResolvedValue({
      orgId: 1,
      projectId: 10,
    });
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const res = await server.request('/chapter-assignments/1/comments', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('allows list with project-scoped content:view on own project', async () => {
    asAuthenticatedUser([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW]),
      },
    ]);
    vi.mocked(draftCommentsService.listChapterComments).mockResolvedValue(
      ok({ connected: [], unconnected: [] })
    );
    const res = await server.request('/chapter-assignments/1/comments', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('forbids list when grant is for another project', async () => {
    asAuthenticatedUser([
      {
        orgId: 1,
        projectId: 99,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
      },
    ]);
    const res = await server.request('/chapter-assignments/1/comments', { method: 'GET' });
    expect(res.status).toBe(403);
  });

  it('forbids create when content:view present but comment:write revoked/missing', async () => {
    asAuthenticatedUser([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.CONTENT_UPDATE]),
      },
    ]);
    const res = await server.request('/chapter-assignments/1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anchor: { kind: 'verse', bibleTextId: 1 },
        body: { kind: 'text', text: 'hi' },
      }),
    });
    expect(res.status).toBe(403);
    expect(draftCommentsService.createTopLevelComment).not.toHaveBeenCalled();
  });

  it('allows create with project-scoped comment:write (Observer-shaped)', async () => {
    asAuthenticatedUser([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
      },
    ]);
    vi.mocked(draftCommentsService.createTopLevelComment).mockResolvedValue(
      ok({
        id: 1,
        projectId: 10,
        chapterAssignmentId: 1,
        parentCommentId: null,
        author: { userId: 1, displayName: 'observer', roleDisplay: 'Project Observer' },
        createdAt: '2026-01-01T00:00:00.000Z',
        bodyKind: 'text',
        text: 'hi',
        emoji: null,
        audio: null,
        anchor: {
          kind: 'verse',
          bibleId: 1,
          bookId: 40,
          chapterNumber: 1,
          bibleTextId: 1,
          verseNumber: 1,
          pericopeSetId: null,
          pericopeNumber: null,
          pericopeTitle: null,
        },
        connectionState: 'connected',
        reactions: [],
        currentUserReaction: null,
      })
    );
    const res = await server.request('/chapter-assignments/1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anchor: { kind: 'verse', bibleTextId: 1 },
        body: { kind: 'text', text: 'hi' },
      }),
    });
    expect(res.status).toBe(201);
    expect(draftCommentsService.createTopLevelComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      1,
      expect.objectContaining({ body: { kind: 'text', text: 'hi' } })
    );
  });

  it('returns 404 when assignment scope is unknown (FA-R4)', async () => {
    asAuthenticatedUser([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
      },
    ]);
    vi.mocked(draftCommentsService.resolveCommentAssignmentScope).mockResolvedValue(null);
    const res = await server.request('/chapter-assignments/999/comments', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it.each(['1.5', '0', 'foo'])(
    'returns 404 for non-integer/non-positive chapterAssignmentId %s before scope lookup',
    async (id) => {
      asAuthenticatedUser([
        {
          orgId: 1,
          projectId: 10,
          permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
        },
      ]);
      const res = await server.request(`/chapter-assignments/${id}/comments`, { method: 'GET' });
      expect(res.status).toBe(404);
      expect(draftCommentsService.resolveCommentAssignmentScope).not.toHaveBeenCalled();
    }
  );

  it('returns 413 for oversize audio Content-Length before parseBody', async () => {
    asAuthenticatedUser([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
      },
    ]);
    // bodyLimit allows MAX_COMMENT_AUDIO_BYTES + 64KiB for multipart framing.
    const res = await server.request('/chapter-assignments/1/comments/audio', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=----bound',
        'content-length': String(30 * 1024 * 1024 + 64 * 1024 + 1),
      },
      body: 'x',
    });
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      message: 'Request body exceeds the audio upload limit',
    });
    expect(draftCommentsService.createAudioComment).not.toHaveBeenCalled();
  });

  it('POST /comments/audio passes replyToCommentId and omits caller anchor', async () => {
    asAuthenticatedUser([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
      },
    ]);
    vi.mocked(draftCommentsService.createAudioComment).mockResolvedValue(
      ok({
        id: 3,
        projectId: 10,
        chapterAssignmentId: 1,
        parentCommentId: 7,
        author: { userId: 1, displayName: 'observer', roleDisplay: null },
        createdAt: '2026-01-01T00:00:00.000Z',
        bodyKind: 'audio',
        text: null,
        emoji: null,
        audio: {
          contentType: 'audio/mp4',
          byteSize: 4,
          durationSeconds: 1,
          contentHash: 'abc',
          downloadUrl: null,
        },
        anchor: {
          kind: 'verse',
          bibleId: 1,
          bookId: 40,
          chapterNumber: 1,
          bibleTextId: 1,
          verseNumber: 1,
          pericopeSetId: null,
          pericopeNumber: null,
          pericopeTitle: null,
        },
        connectionState: 'unconnected',
        reactions: [],
        currentUserReaction: null,
      })
    );

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'clip.m4a', { type: 'audio/mp4' }));
    form.set('replyToCommentId', '7');
    form.set('anchorKind', 'verse');
    form.set('bibleTextId', '999');

    const res = await server.request('/chapter-assignments/1/comments/audio', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(201);
    expect(draftCommentsService.createAudioComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      1,
      null,
      expect.objectContaining({ contentType: 'audio/mp4' }),
      null,
      7
    );
  });
});
