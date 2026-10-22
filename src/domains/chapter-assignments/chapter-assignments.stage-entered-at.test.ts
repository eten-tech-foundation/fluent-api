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

  it('returns null when the entry row createdAt is null', () => {
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

  it('treats null createdAt as later than dated rows (NULLS LAST)', () => {
    expect(
      resolveStageEnteredAt(
        'peer_check',
        rows(
          { id: 1, status: 'peer_check', createdAt: t('2026-01-02T00:00:00.000Z') },
          { id: 2, status: 'peer_check', createdAt: null }
        )
      )
    ).toBe('2026-01-02T00:00:00.000Z');
  });
});
