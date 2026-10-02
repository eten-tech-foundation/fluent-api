import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import './playback-audio.route';

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() }, handler: vi.fn() },
}));
vi.mock('@/db', () => {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return { db: { select: vi.fn(() => query), insert: vi.fn(), update: vi.fn() } };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/users/users.service', () => ({ getUserByEmail: vi.fn() }));
vi.mock('@/domains/user-roles/user-roles.repository', () => ({ findGrantsByUserId: vi.fn() }));
vi.mock('@/domains/projects/projects.service', () => ({ getProjectById: vi.fn() }));
vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));
vi.mock('@/domains/source-audio/source-audio.service', () => ({
  isBibleBookLinkedToProject: vi.fn(),
}));
vi.mock('@/domains/bible-provider-resources/bible-provider-resources.service', () => ({
  getById: vi.fn(),
  getByProviderIdentity: vi.fn(),
}));
vi.mock('@/domains/bibles/bibles.service', () => ({ getBibleRecordById: vi.fn() }));
vi.mock('@/lib/services/dbl/dbl.client', () => ({
  dblClient: { getBible: vi.fn(), getAudioChapter: vi.fn(), getVerses: vi.fn() },
}));
vi.mock('./playback-audio.repository', () => ({ getSourceChapterVerseNumbers: vi.fn() }));

const path = '/projects/10/reference-audio/dbl-text-id/JHN/3?languageCode=eng';
const audioChapter = {
  id: 'JHN.3',
  resourceUrl: 'https://example.com/audio.mp3',
  timecodes: [
    { verseId: 'JHN.3.1', start: '0', end: '4' },
    { verseId: 'JHN.3.2', start: '4', end: '8' },
  ],
};

function authenticate() {
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: { id: 'test', updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    user: { email: 'test@example.com' },
  } as never);
  vi.mocked(getUserByEmail).mockResolvedValue(
    ok({ id: 1, email: 'test@example.com', status: 'verified' } as never)
  );
  vi.mocked(findGrantsByUserId).mockResolvedValue(
    ok([{ orgId: 1, projectId: 10, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) }] as never)
  );
  vi.mocked(getProjectById).mockResolvedValue(ok({ id: 10, organization: 1 } as never));
  vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate();
  vi.mocked(resources.getByProviderIdentity).mockResolvedValue(ok(null));
  vi.mocked(dblClient.getBible).mockResolvedValue(
    ok({
      id: 'text-id',
      name: 'Reference Bible',
      abbreviation: 'REF',
      audioBibles: [{ id: 'audio-id', name: 'Reference Audio' }],
    } as never)
  );
  vi.mocked(dblClient.getAudioChapter).mockResolvedValue(ok(audioChapter as never));
  vi.mocked(dblClient.getVerses).mockResolvedValue(
    ok([{ id: 'JHN.3.1' }, { id: 'JHN.3.2' }] as never)
  );
});

describe('authenticated DBL reference playback fixtures', () => {
  it('returns a verse-addressable track when the exact reference has complete timecodes', async () => {
    const response = await server.request(path);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: 'dbl',
      textBibleKey: 'dbl-text-id',
      selectedRecordingKey: null,
      verseAddressable: true,
      items: [{ recordingKey: 'dbl-audio-id', trackId: 'JHN.3' }],
    });
    expect(dblClient.getBible).toHaveBeenCalledWith('text-id');
  });

  it('keeps a DBL reference track playable but windowless when timecodes are absent', async () => {
    vi.mocked(dblClient.getAudioChapter).mockResolvedValue(
      ok({ ...audioChapter, timecodes: null } as never)
    );

    const response = await server.request(path);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verseAddressable: false, items: [{}] });
    expect(dblClient.getVerses).not.toHaveBeenCalled();
  });

  it('returns no track for a typed missing DBL audio chapter', async () => {
    vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
      ok: false,
      error: {
        code: ErrorCode.DBL_AUDIO_CHAPTER_NOT_FOUND,
        message: 'DBL audio chapter not found',
      },
    });

    const response = await server.request(path);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verseAddressable: false, items: [] });
  });

  it('propagates a DBL provider failure instead of reporting absent audio', async () => {
    vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
      ok: false,
      error: { code: ErrorCode.DBL_SERVICE_UNAVAILABLE, message: 'DBL API is unavailable' },
    });

    const response = await server.request(path);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: 'DBL API is unavailable' });
  });
});
