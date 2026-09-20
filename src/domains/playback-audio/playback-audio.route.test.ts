import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import * as sourceAudioRepo from '@/domains/source-audio/source-audio.repository';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import * as playback from './playback-audio.service';
import './playback-audio.route';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return {
    db: { select: vi.fn(() => mockQueryBuilder), insert: vi.fn(), update: vi.fn() },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

vi.mock('./playback-audio.service', () => ({
  getResourceFacts: vi.fn(),
  getSourcePlayback: vi.fn(),
  getReferencePlayback: vi.fn(),
}));

vi.mock('@/domains/source-audio/source-audio.repository', () => ({
  isBibleBookLinkedToProject: vi.fn(),
}));

const paths = [
  '/projects/10/bible-resources/aq-1',
  '/projects/10/playback-audio/JHN/3?languageCode=eng&bibleId=2',
  '/projects/10/reference-audio/aq-1/JHN/3?languageCode=eng',
];
function authenticated(permission = true, member = true) {
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: { id: 'test', updatedAt: new Date(), expiresAt: new Date(Date.now() + 100000) },
    user: { email: 'test@example.com' },
  } as never);
  vi.mocked(getUserByEmail).mockResolvedValue(
    ok({ id: 1, email: 'test@example.com', status: 'verified' } as never)
  );
  vi.mocked(findGrantsByUserId).mockResolvedValue(
    ok(
      permission
        ? ([
            { orgId: 999, projectId: 999, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) },
          ] as never)
        : []
    )
  );
  vi.mocked(getProjectById).mockResolvedValue(ok({ id: 10, organization: 1 } as never));
  vi.mocked(resolveIsProjectMember).mockResolvedValue(member);
}
beforeEach(() => {
  vi.clearAllMocks();
  authenticated();
  vi.mocked(sourceAudioRepo.isBibleBookLinkedToProject).mockResolvedValue(ok(true));
  vi.mocked(playback.getResourceFacts).mockResolvedValue(
    ok({
      id: null,
      provider: 'aquifer',
      externalId: '1',
      bibleKey: 'aq-1',
      ttsLicenseStatus: 'unknown',
      licenseNotice: null,
    })
  );
  const media = {
    provider: 'aquifer' as const,
    bible: { name: 'BSB', abbreviation: 'BSB' },
    bookCode: 'JHN' as const,
    chapter: 3,
    items: [],
    textBibleKey: 'aq-1',
    selectedRecordingKey: null,
    ttsLicenseStatus: 'unknown' as const,
    verseAddressable: false,
  };
  vi.mocked(playback.getSourcePlayback).mockResolvedValue(ok(media));
  vi.mocked(playback.getReferencePlayback).mockResolvedValue(ok(media));
});
describe('playback project boundary', () => {
  it.each(paths)('requires auth: %s', async (path) => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    expect((await server.request(path)).status).toBe(401);
  });
  it.each(paths)('requires PROJECT_VIEW: %s', async (path) => {
    authenticated(false);
    expect((await server.request(path)).status).toBe(403);
  });
  it.each(paths)('requires project READ: %s', async (path) => {
    authenticated(true, false);
    expect((await server.request(path)).status).toBe(404);
  });
  it.each(paths)('permits project members: %s', async (path) => {
    expect((await server.request(path)).status).toBe(200);
  });
  it('only source requires imported Bible/book membership', async () => {
    vi.mocked(sourceAudioRepo.isBibleBookLinkedToProject).mockResolvedValue(ok(false));
    expect((await server.request(paths[1])).status).toBe(404);
    expect(playback.getSourcePlayback).not.toHaveBeenCalled();
    vi.mocked(sourceAudioRepo.isBibleBookLinkedToProject).mockClear();
    expect((await server.request(paths[2])).status).toBe(200);
    expect(sourceAudioRepo.isBibleBookLinkedToProject).not.toHaveBeenCalled();
  });
  it('does not swallow membership database failures', async () => {
    vi.mocked(sourceAudioRepo.isBibleBookLinkedToProject).mockResolvedValue(
      err(ErrorCode.INTERNAL_ERROR)
    );
    expect((await server.request(paths[1])).status).toBe(500);
  });
  it.each([
    '/projects/10/bible-resources/aq-01',
    '/projects/10/reference-audio/aq-1/JHN/3',
    '/projects/10/reference-audio/dbl-id/JHN/3?languageCode=eng',
  ])('rejects invalid identity/scope or missing reference language: %s', async (path) => {
    expect((await server.request(path)).status).toBe(400);
  });
  it('returns successful unknown for missing resource facts and 500 on read failure', async () => {
    const response = await server.request(paths[0]);
    expect(await response.json()).toMatchObject({
      id: null,
      ttsLicenseStatus: 'unknown',
      licenseNotice: null,
    });
    vi.mocked(playback.getResourceFacts).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    expect((await server.request(paths[0])).status).toBe(500);
  });
});
