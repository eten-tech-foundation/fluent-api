/* eslint-disable ts/no-explicit-any -- The fluent Drizzle query mock must implement several query-builder stages through one recursive test double. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';

import { resolveCanonicalPassage } from './assistant.repository';

vi.mock('@/db', () => ({ db: { select: vi.fn() } }));

function queueQueries(...results: unknown[][]) {
  for (const rows of results) {
    vi.mocked(db.select).mockImplementationOnce(() => {
      const query: any = {
        from: vi.fn(() => query),
        innerJoin: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(async () => rows),
        limit: vi.fn(async () => rows),
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return query;
    });
  }
}

const input = { projectId: 7, bookCode: 'mat', chapter: 4, activeVerse: 25 };
const project = {
  sourceBibleId: 9,
  pericopeSetId: 3,
  sourceBible: 'Canonical Source',
  sourceLanguageCode: 'eng',
};
const book = { id: 40, code: 'MAT' };
const membership = { number: '12', section: null };
const expected = [
  { chapter: 4, verse: 25 },
  { chapter: 5, verse: 1 },
  { chapter: 5, verse: 2 },
];
const source = [
  { chapter: 4, verse: 25, text: 'first' },
  { chapter: 5, verse: 1, text: 'second' },
  { chapter: 5, verse: 2, text: 'third' },
];

describe('canonical Assistant passage resolution', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns the complete ordered cross-chapter pericope from the source Bible', async () => {
    queueQueries([project], [book], [membership], expected, source);
    await expect(resolveCanonicalPassage(input)).resolves.toEqual({
      sourceBible: 'Canonical Source',
      sourceLanguageCode: 'eng',
      verses: [
        { bookCode: 'MAT', chapter: 4, verse: 25, text: 'first' },
        { bookCode: 'MAT', chapter: 5, verse: 1, text: 'second' },
        { bookCode: 'MAT', chapter: 5, verse: 2, text: 'third' },
      ],
    });
  });

  it('rejects canonical context without a project source-language code', async () => {
    queueQueries([{ ...project, sourceLanguageCode: null }]);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an interior verse is missing', [source[0], source[2]]],
    ['the second chapter is missing', [source[0]]],
    ['a source reference is duplicated', [source[0], source[1], source[1], source[2]]],
  ])('fails before generation when %s', async (_label, sourceRows) => {
    queueQueries([project], [book], [membership], expected, sourceRows);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });

  it('rejects an ambiguous active-verse membership', async () => {
    queueQueries([project], [book], [membership, { number: '13', section: 2 }]);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it('uses only the exact source verse when the project has no pericope set', async () => {
    queueQueries(
      [{ ...project, pericopeSetId: null }],
      [book],
      [{ chapter: 4, verse: 25, text: 'fallback' }]
    );
    await expect(resolveCanonicalPassage(input)).resolves.toMatchObject({
      verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'fallback' }],
    });
  });

  it('uses the exact source verse when the active verse has no covering pericope', async () => {
    queueQueries([project], [book], [], [{ chapter: 4, verse: 25, text: 'fallback' }]);
    await expect(resolveCanonicalPassage(input)).resolves.toMatchObject({
      verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'fallback' }],
    });
  });

  it('rejects a missing fallback verse when no pericope covers the active verse', async () => {
    queueQueries([project], [book], [], []);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });

  it.each([
    { fallback: [] },
    {
      fallback: [
        { chapter: 4, verse: 25, text: 'a' },
        { chapter: 4, verse: 25, text: 'b' },
      ],
    },
  ])('rejects a missing or ambiguous exact fallback verse', async ({ fallback }) => {
    queueQueries([{ ...project, pericopeSetId: null }], [book], fallback);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });
});
