import type { CommentAnchorInput } from './draft-comments.types';

import { COMMENT_ANCHOR_KIND, COMMENT_CONNECTION_STATE } from './draft-comments.types';

interface ResolvedVerseAnchor {
  kind: typeof COMMENT_ANCHOR_KIND.VERSE;
  bibleId: number;
  bookId: number;
  chapterNumber: number;
  bibleTextId: number;
  verseNumber: number;
  pericopeSetId: null;
  pericopeNumber: null;
  pericopeTitle: null;
}

interface ResolvedPericopeAnchor {
  kind: typeof COMMENT_ANCHOR_KIND.PERICOPE;
  bibleId: number;
  bookId: number;
  chapterNumber: number;
  bibleTextId: null;
  verseNumber: null;
  pericopeSetId: number;
  pericopeNumber: string;
  pericopeTitle: string | null;
}

type ResolvedAnchorSnapshot = ResolvedVerseAnchor | ResolvedPericopeAnchor;

interface AssignmentGeometry {
  projectId: number;
  bibleId: number;
  bookId: number;
  chapterNumber: number;
  pericopeSetId: number | null;
}

interface BibleTextRow {
  id: number;
  bibleId: number;
  bookId: number;
  chapterNumber: number;
  verseNumber: number;
}

interface PericopeMembershipRow {
  pericopeSetId: number;
  bookId: number;
  chapterNumber: number;
  pericopeNumber: string;
  pericopeTitle: string | null;
}

/** Validate create-time anchor against assignment geometry; returns immutable snapshot fields. */
export function resolveAnchorSnapshot(
  input: CommentAnchorInput,
  assignment: AssignmentGeometry,
  bibleText: BibleTextRow | null,
  pericopeMembership: PericopeMembershipRow | null
): ResolvedAnchorSnapshot | { error: 'INVALID_REFERENCE' } {
  if (input.kind === COMMENT_ANCHOR_KIND.VERSE) {
    if (!bibleText || bibleText.id !== input.bibleTextId) {
      return { error: 'INVALID_REFERENCE' };
    }
    if (
      bibleText.bibleId !== assignment.bibleId ||
      bibleText.bookId !== assignment.bookId ||
      bibleText.chapterNumber !== assignment.chapterNumber
    ) {
      return { error: 'INVALID_REFERENCE' };
    }
    return {
      kind: COMMENT_ANCHOR_KIND.VERSE,
      bibleId: bibleText.bibleId,
      bookId: bibleText.bookId,
      chapterNumber: bibleText.chapterNumber,
      bibleTextId: bibleText.id,
      verseNumber: bibleText.verseNumber,
      pericopeSetId: null,
      pericopeNumber: null,
      pericopeTitle: null,
    };
  }

  if (assignment.pericopeSetId == null) {
    return { error: 'INVALID_REFERENCE' };
  }
  if (input.pericopeSetId != null && input.pericopeSetId !== assignment.pericopeSetId) {
    return { error: 'INVALID_REFERENCE' };
  }
  if (
    !pericopeMembership ||
    pericopeMembership.pericopeSetId !== assignment.pericopeSetId ||
    pericopeMembership.bookId !== assignment.bookId ||
    pericopeMembership.chapterNumber !== assignment.chapterNumber ||
    pericopeMembership.pericopeNumber !== input.pericopeNumber
  ) {
    return { error: 'INVALID_REFERENCE' };
  }

  return {
    kind: COMMENT_ANCHOR_KIND.PERICOPE,
    bibleId: assignment.bibleId,
    bookId: assignment.bookId,
    chapterNumber: assignment.chapterNumber,
    bibleTextId: null,
    verseNumber: null,
    pericopeSetId: pericopeMembership.pericopeSetId,
    pericopeNumber: pericopeMembership.pericopeNumber,
    pericopeTitle: pericopeMembership.pericopeTitle,
  };
}

/**
 * Application-level sticky guard: never transition unconnected → connected.
 * Structural invalidation uses DB triggers / markUnconnected*; this blocks mistaken reattach.
 */
export function assertStickyConnectionTransition(
  current: string,
  next: string
): { ok: true } | { ok: false; reason: 'reattach_forbidden' } {
  if (
    current === COMMENT_CONNECTION_STATE.UNCONNECTED &&
    next === COMMENT_CONNECTION_STATE.CONNECTED
  ) {
    return { ok: false, reason: 'reattach_forbidden' };
  }
  return { ok: true };
}
