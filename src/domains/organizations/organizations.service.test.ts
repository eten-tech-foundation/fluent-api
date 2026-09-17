import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/types';

import * as repo from './organizations.repository';
import { createOrganization, getOrganization, listOrganizations } from './organizations.service';

vi.mock('@/domains/organizations/organizations.repository', () => ({
  findAllWithCounts: vi.fn(),
  findByIdWithCounts: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const summaryRow = (id: number, name: string, orgManagerCount: number) => ({
  id,
  name,
  createdAt: new Date('2026-09-16T12:00:00.000Z'),
  orgManagerCount,
});

describe('organizations service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listOrganizations', () => {
    it('returns summaries ordered by name with orgManagerCount', async () => {
      vi.mocked(repo.findAllWithCounts).mockResolvedValue({
        ok: true,
        data: [summaryRow(1, 'Alpha Org', 2), summaryRow(2, 'Beta Org', 0)],
      });

      const result = await listOrganizations();

      expect(result).toEqual({
        ok: true,
        data: [
          {
            id: 1,
            name: 'Alpha Org',
            createdAt: '2026-09-16T12:00:00.000Z',
            orgManagerCount: 2,
          },
          {
            id: 2,
            name: 'Beta Org',
            createdAt: '2026-09-16T12:00:00.000Z',
            orgManagerCount: 0,
          },
        ],
      });
    });

    it('propagates repository errors', async () => {
      vi.mocked(repo.findAllWithCounts).mockResolvedValue({
        ok: false,
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred' },
      });

      const result = await listOrganizations();
      expect(result.ok).toBe(false);
    });
  });

  describe('getOrganization', () => {
    it('returns the summary for an existing org', async () => {
      vi.mocked(repo.findByIdWithCounts).mockResolvedValue({
        ok: true,
        data: summaryRow(1, 'Alpha Org', 3),
      });

      const result = await getOrganization(1);

      expect(result).toEqual({
        ok: true,
        data: {
          id: 1,
          name: 'Alpha Org',
          createdAt: '2026-09-16T12:00:00.000Z',
          orgManagerCount: 3,
        },
      });
    });

    it('returns NOT_FOUND for a missing org', async () => {
      vi.mocked(repo.findByIdWithCounts).mockResolvedValue({ ok: true, data: null });

      const result = await getOrganization(999);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
      }
    });
  });

  describe('createOrganization', () => {
    it('returns the created organization', async () => {
      vi.mocked(repo.insert).mockResolvedValue({
        ok: true,
        data: { id: 5, name: 'New Org', createdAt: new Date('2026-09-16T12:00:00.000Z') },
      });

      const result = await createOrganization({ name: 'New Org' });

      expect(result).toEqual({
        ok: true,
        data: { id: 5, name: 'New Org', createdAt: '2026-09-16T12:00:00.000Z' },
      });
    });

    it('maps a duplicate name to CONFLICT', async () => {
      vi.mocked(repo.insert).mockResolvedValue({
        ok: false,
        error: { code: ErrorCode.DUPLICATE, message: 'Resource already exists' },
      });

      const result = await createOrganization({ name: 'Taken Name' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.CONFLICT);
      }
    });
  });
});
