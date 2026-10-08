import type { DemoChapter, DemoChapterStatus } from './types';

export interface SpreadOptions {
  /**
   * Two user keys who peer-check each other's chapters. When a chapter lands
   * on one member, `peerChecker` is set to the other.
   */
  peerPair?: [string, string];
}

/**
 * Deterministically generates a chapter list for a spec book so specs stay
 * compact: statuses are declared as weighted groups (expanded in order across
 * chapters 1..count) and assignees round-robin by chapter number.
 *
 * The status counts must sum exactly to `chapterCount` — declare `not_started`
 * explicitly for untouched chapters rather than leaving a remainder.
 */
export function spread(
  chapterCount: number,
  statuses: { status: DemoChapterStatus; count: number }[],
  users: string[],
  opts: SpreadOptions = {}
): DemoChapter[] {
  const total = statuses.reduce((sum, s) => sum + s.count, 0);
  if (total !== chapterCount) {
    throw new Error(`spread(): status counts sum to ${total}, but chapterCount is ${chapterCount}`);
  }
  if (users.length === 0) {
    throw new Error('spread(): at least one assignee is required');
  }

  const expanded = statuses.flatMap((s) => Array.from({ length: s.count }, () => s.status));

  return expanded.map((status, i) => {
    const assignedTo = users[i % users.length];
    const peerChecker =
      opts.peerPair && opts.peerPair.includes(assignedTo)
        ? opts.peerPair.find((k) => k !== assignedTo)
        : undefined;
    return { number: i + 1, status, assignedTo, peerChecker };
  });
}
