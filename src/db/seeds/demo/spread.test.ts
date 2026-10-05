import { describe, expect, it } from 'vitest';

import { spread } from './spread';

describe('spread', () => {
  it('returns one chapter per chapter number, starting at 1', () => {
    const chapters = spread(5, [{ status: 'draft', count: 5 }], ['u1']);
    expect(chapters.map((c) => c.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('expands status groups in declared order', () => {
    const chapters = spread(
      6,
      [
        { status: 'complete', count: 2 },
        { status: 'peer_check', count: 2 },
        { status: 'draft', count: 2 },
      ],
      ['u1']
    );
    expect(chapters.map((c) => c.status)).toEqual([
      'complete',
      'complete',
      'peer_check',
      'peer_check',
      'draft',
      'draft',
    ]);
  });

  it('round-robins assignees across chapters', () => {
    const chapters = spread(6, [{ status: 'draft', count: 6 }], ['alice', 'bob', 'carol']);
    expect(chapters.map((c) => c.assignedTo)).toEqual([
      'alice',
      'bob',
      'carol',
      'alice',
      'bob',
      'carol',
    ]);
  });

  it('pairs peer-checkers: each member of peerPair checks the other', () => {
    const chapters = spread(4, [{ status: 'peer_check', count: 4 }], ['m1', 'm2', 'solo'], {
      peerPair: ['m1', 'm2'],
    });
    const [m1Ch, m2Ch, soloCh] = chapters;
    expect(m1Ch.peerChecker).toBe('m2');
    expect(m2Ch.peerChecker).toBe('m1');
    expect(soloCh.peerChecker).toBeUndefined();
  });

  it('throws when status counts do not sum to the chapter count', () => {
    expect(() => spread(5, [{ status: 'draft', count: 4 }], ['u1'])).toThrow();
    expect(() => spread(5, [{ status: 'draft', count: 6 }], ['u1'])).toThrow();
  });
});
