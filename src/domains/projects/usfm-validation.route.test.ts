import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import * as usfmImportService from './usfm-import.service';
import './usfm-validation.route';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return { db: { select: vi.fn(() => query), insert: vi.fn(), update: vi.fn() } };
});

vi.mock('@/domains/users/users.service', () => ({ getUserByEmail: vi.fn() }));
vi.mock('@/domains/user-roles/user-roles.repository', () => ({ findGrantsByUserId: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('./usfm-import.service', () => ({ checkUsfmFiles: vi.fn() }));

function signedIn(status: 'verified' | 'inactive' = 'verified') {
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: { id: 'session-1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: 'manager@example.com' },
  } as any);
  vi.mocked(getUserByEmail).mockResolvedValue(
    ok({ id: 1, email: 'manager@example.com', status } as any)
  );
  vi.mocked(findGrantsByUserId).mockResolvedValue(ok([]));
}

const check = (body: unknown) =>
  server.request('/projects/usfm-validation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const FILES = [{ fileName: 'OBA.usfm', usfm: '\\id OBA\n\\c 1\n\\p\n\\v 1 The vision.' }];

describe('the usfm-validation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires a signed-in user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const response = await check({ files: FILES });

    expect(response.status).toBe(401);
    expect(usfmImportService.checkUsfmFiles).not.toHaveBeenCalled();
  });

  it('turns away an inactive account', async () => {
    signedIn('inactive');

    const response = await check({ files: FILES });

    expect(response.status).toBe(403);
    expect(usfmImportService.checkUsfmFiles).not.toHaveBeenCalled();
  });

  it('answers with one verdict per file', async () => {
    signedIn();
    const verdicts = [
      { fileName: 'OBA.usfm', ok: true as const, bookCode: 'OBA', bookName: 'Obadiah' },
      {
        fileName: 'notes.usfm',
        ok: false as const,
        error: 'USFM_INVALID' as const,
        message: 'File is not valid USFM',
      },
    ];
    vi.mocked(usfmImportService.checkUsfmFiles).mockResolvedValue(ok(verdicts));

    const files = [...FILES, { fileName: 'notes.usfm', usfm: '' }];
    const response = await check({ files });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ files: verdicts });
    expect(usfmImportService.checkUsfmFiles).toHaveBeenCalledWith(files);
  });

  it('refuses a body without files', async () => {
    signedIn();

    const response = await check({ files: [] });

    expect(response.status).toBe(400);
    expect(usfmImportService.checkUsfmFiles).not.toHaveBeenCalled();
  });

  it('reports a failure to read the books as a server error', async () => {
    signedIn();
    vi.mocked(usfmImportService.checkUsfmFiles).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const response = await check({ files: FILES });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: 'An unexpected error occurred' });
  });
});
