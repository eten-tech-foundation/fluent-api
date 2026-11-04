import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isAudioStorageAvailable } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import * as verseAudioService from './verse-audio.service';
import { recordWithUrl } from './verse-audio.test-fixtures';
import './verse-audio.route';

vi.mock('@/lib/audio-storage', () => ({
  isAudioStorageAvailable: vi.fn(() => true),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

// Stub global authenticate so this suite does not need vi.mock('@/db') (FA-L7).
vi.mock('@/middlewares/authenticate', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    authenticate: createMiddleware(async (c, next) => {
      c.set('user', {
        id: 1,
        email: 'translator@example.com',
        status: 'verified',
        grants: [
          {
            orgId: 1,
            projectId: 1,
            permissions: new Set(['content:update', 'project:view']),
          },
        ],
      });
      await next();
    }),
  };
});

// Pass-through verse-audio auth; sets project for deleteTake scope.
vi.mock('./verse-audio-auth.middleware', async () => {
  const { createMiddleware } = await import('hono/factory');
  const allow = () =>
    createMiddleware(async (c, next) => {
      c.set('project', { id: 1, name: 'Test Project', organization: 1 });
      await next();
    });
  return {
    requireReadVerseAudioAccess: allow,
    requireEditVerseAudioAccess: allow,
    requireResolveVerseAudioConflictAccess: allow,
  };
});

vi.mock('./verse-audio.service', () => ({
  uploadRecording: vi.fn(),
  getRecording: vi.fn(),
  getCurrentVersionToken: vi.fn(),
  listChapterRecordings: vi.fn(),
  resolveConflict: vi.fn(),
  deleteRecording: vi.fn(),
  deleteTake: vi.fn(),
}));

describe('DELETE /verse-audio/{projectUnitId}/{bibleTextId}/takes/{takeId}', () => {
  const deleteTake = (takeId = '42', query = '') =>
    server.request(`/verse-audio/1/10/takes/${takeId}${query}`, { method: 'DELETE' });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAudioStorageAvailable).mockReturnValue(true);
  });

  it('returns 200 with the unit and passes actor plus project scope', async () => {
    vi.mocked(verseAudioService.deleteTake).mockResolvedValue(ok(recordWithUrl));

    const res = await deleteTake();

    expect(res.status).toBe(200);
    expect(verseAudioService.deleteTake).toHaveBeenCalledWith({
      projectUnitId: 1,
      bibleTextId: 10,
      takeId: 42,
      actor: expect.objectContaining({ id: 1 }),
      scope: { orgId: 1, projectId: 1 },
      baseVersionToken: undefined,
    });
  });

  it('forwards a matching baseVersionToken query param', async () => {
    vi.mocked(verseAudioService.deleteTake).mockResolvedValue(ok(recordWithUrl));

    expect((await deleteTake('42', '?baseVersionToken=3')).status).toBe(200);
    expect(verseAudioService.deleteTake).toHaveBeenCalledWith(
      expect.objectContaining({ baseVersionToken: 3 })
    );
  });

  it('rejects a malformed baseVersionToken without calling the service', async () => {
    expect((await deleteTake('42', '?baseVersionToken=0')).status).toBe(400);
    expect(verseAudioService.deleteTake).not.toHaveBeenCalled();
  });

  it.each([
    [ErrorCode.FORBIDDEN, 403],
    [ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND, 404],
    [ErrorCode.VERSE_AUDIO_VERSION_CONFLICT, 409],
  ])('maps %s to %i', async (code, status) => {
    vi.mocked(verseAudioService.deleteTake).mockResolvedValue(err(code));
    if (code === ErrorCode.VERSE_AUDIO_VERSION_CONFLICT) {
      vi.mocked(verseAudioService.getCurrentVersionToken).mockResolvedValue(ok(7));
    }

    const res = await deleteTake();
    expect(res.status).toBe(status);
    if (status === 409) {
      expect(await res.json()).toEqual(expect.objectContaining({ currentVersionToken: 7 }));
    }
  });

  it('rejects a non-numeric takeId without calling the service', async () => {
    expect((await deleteTake('abc')).status).toBe(400);
    expect(verseAudioService.deleteTake).not.toHaveBeenCalled();
  });
});
