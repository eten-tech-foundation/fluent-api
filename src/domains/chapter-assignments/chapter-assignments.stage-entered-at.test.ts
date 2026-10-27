import { describe, expect, it } from 'vitest';

import type { StatusHistoryRow } from './chapter-assignments.stage-entered-at';

import { resolveStageEnteredAt } from './chapter-assignments.stage-entered-at';

const t = (iso: string) => new Date(iso);

function rows(...items: StatusHistoryRow[]): StatusHistoryRow[] {
  return items;
}

describe('resolveStageEnteredAt', () => {
  it('returns the current-stage entry timestamp', () => {
    expect(
      resolveStageEnteredAt(
        'peer_check',
        rows(
          { id: 1, status: 'draft', createdAt: t('2026-01-01T00:00:00.000Z') },
          { id: 2, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') }
        )
      )
    ).toBe('2026-01-02T00:00:00.000Z');
  });

  it('uses the latest contiguous run on re-entry', () => {
    expect(
      resolveStageEnteredAt(
        'peer_check',
        rows(
          { id: 1, status: 'draft', createdAt: t('2026-01-01T00:00:00.000Z') },
          { id: 2, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') },
          { id: 3, status: 'community_review', createdAt: t('2026-01-03T00:00:00.000Z') },
          { id: 4, status: 'peer_check', createdAt: t('2026-01-04T00:00:00.000Z') }
        )
      )
    ).toBe('2026-01-04T00:00:00.000Z');
  });

  it('collapses repeated same-status rows to the start of the trailing run', () => {
    expect(
      resolveStageEnteredAt(
        'peer_check',
        rows(
          { id: 1, status: 'draft', createdAt: t('2026-01-01T00:00:00.000Z') },
          { id: 2, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') },
          { id: 3, status: 'peer_check', createdAt: t('2026-01-03T00:00:00.000Z') }
        )
      )
    ).toBe('2026-01-02T00:00:00.000Z');
  });

  it('returns null when history is missing', () => {
    expect(resolveStageEnteredAt('draft', [])).toBeNull();
  });

  it('returns null when any history row has null createdAt (sole row)', () => {
    expect(
      resolveStageEnteredAt('draft', rows({ id: 1, status: 'draft', createdAt: null }))
    ).toBeNull();
  });

  it('returns null when latest history status mismatches current status', () => {
    expect(
      resolveStageEnteredAt(
        'peer_check',
        rows(
          { id: 1, status: 'draft', createdAt: t('2026-01-01T00:00:00.000Z') },
          { id: 2, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') },
          { id: 3, status: 'draft', createdAt: t('2026-01-03T00:00:00.000Z') }
        )
      )
    ).toBeNull();
  });

  it('breaks createdAt ties with serial id ordering', () => {
    const same = t('2026-01-02T00:00:00.000Z');
    expect(
      resolveStageEnteredAt(
        'peer_check',
        // Unsorted on purpose — resolver must order by createdAt then id.
        rows(
          { id: 3, status: 'peer_check', createdAt: same },
          { id: 1, status: 'draft', createdAt: same },
          { id: 2, status: 'peer_check', createdAt: same }
        )
      )
    ).toBe('2026-01-02T00:00:00.000Z');

    // Trailing run is ids 2 then 3; entry is the earliest id in that run.
    const entryTime = resolveStageEnteredAt(
      'peer_check',
      rows(
        { id: 1, status: 'draft', createdAt: same },
        { id: 2, status: 'peer_check', createdAt: same },
        { id: 3, status: 'peer_check', createdAt: same }
      )
    );
    expect(entryTime).toBe('2026-01-02T00:00:00.000Z');
  });

  describe('mixed-null history (conservative unavailability)', () => {
    // Parent gap: draft(id1,t1), peer_check(id2,null), peer_check(id3,t3) must
    // not invent t3 via NULLS LAST — any null createdAt → stageEnteredAt null.

    it('returns null when a null createdAt sits between dated same-status rows', () => {
      expect(
        resolveStageEnteredAt(
          'peer_check',
          rows(
            { id: 1, status: 'draft', createdAt: t('2026-01-01T00:00:00.000Z') },
            { id: 2, status: 'peer_check', createdAt: null },
            { id: 3, status: 'peer_check', createdAt: t('2026-01-03T00:00:00.000Z') }
          )
        )
      ).toBeNull();
    });

    it('returns null when null createdAt is before dated current-status rows', () => {
      expect(
        resolveStageEnteredAt(
          'peer_check',
          rows(
            { id: 1, status: 'peer_check', createdAt: null },
            { id: 2, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') }
          )
        )
      ).toBeNull();
    });

    it('returns null when null createdAt is after dated current-status rows', () => {
      expect(
        resolveStageEnteredAt(
          'peer_check',
          rows(
            { id: 1, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') },
            { id: 2, status: 'peer_check', createdAt: null }
          )
        )
      ).toBeNull();
    });

    it('returns null when null createdAt is on a different prior status', () => {
      expect(
        resolveStageEnteredAt(
          'peer_check',
          rows(
            { id: 1, status: 'draft', createdAt: null },
            { id: 2, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') }
          )
        )
      ).toBeNull();
    });

    it('returns null when null createdAt is on a later different status (also mismatch)', () => {
      expect(
        resolveStageEnteredAt(
          'peer_check',
          rows(
            { id: 1, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') },
            { id: 2, status: 'community_review', createdAt: null }
          )
        )
      ).toBeNull();
    });
  });
});
