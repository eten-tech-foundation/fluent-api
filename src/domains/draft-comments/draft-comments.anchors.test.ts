import { describe, expect, it } from 'vitest';

import { assertStickyConnectionTransition, resolveAnchorSnapshot } from './draft-comments.anchors';
import { COMMENT_ANCHOR_KIND, COMMENT_CONNECTION_STATE } from './draft-comments.types';

const assignment = {
  projectId: 1,
  bibleId: 2,
  bookId: 40,
  chapterNumber: 5,
  pericopeSetId: 9,
};

describe('resolveAnchorSnapshot', () => {
  it('snapshots verse geometry independent of takes/hash', () => {
    const snap = resolveAnchorSnapshot(
      { kind: COMMENT_ANCHOR_KIND.VERSE, bibleTextId: 100 },
      assignment,
      {
        id: 100,
        bibleId: 2,
        bookId: 40,
        chapterNumber: 5,
        verseNumber: 3,
      },
      null
    );
    expect(snap).toEqual({
      kind: 'verse',
      bibleId: 2,
      bookId: 40,
      chapterNumber: 5,
      bibleTextId: 100,
      verseNumber: 3,
      pericopeSetId: null,
      pericopeNumber: null,
      pericopeTitle: null,
    });
  });

  it('rejects verse outside assignment chapter coverage', () => {
    const snap = resolveAnchorSnapshot(
      { kind: COMMENT_ANCHOR_KIND.VERSE, bibleTextId: 100 },
      assignment,
      {
        id: 100,
        bibleId: 2,
        bookId: 40,
        chapterNumber: 6,
        verseNumber: 1,
      },
      null
    );
    expect(snap).toEqual({ error: 'INVALID_REFERENCE' });
  });

  it('snapshots pericope set/number/title at create', () => {
    const snap = resolveAnchorSnapshot(
      { kind: COMMENT_ANCHOR_KIND.PERICOPE, pericopeNumber: '4a' },
      assignment,
      null,
      {
        pericopeSetId: 9,
        bookId: 40,
        chapterNumber: 5,
        pericopeNumber: '4a',
        pericopeTitle: 'Title',
      }
    );
    expect(snap).toMatchObject({
      kind: 'pericope',
      pericopeSetId: 9,
      pericopeNumber: '4a',
      pericopeTitle: 'Title',
      bibleTextId: null,
    });
  });

  it('snapshots FCBH public wire id 6_1 (not bare raw 1)', () => {
    const snap = resolveAnchorSnapshot(
      { kind: COMMENT_ANCHOR_KIND.PERICOPE, pericopeNumber: '6_1' },
      assignment,
      null,
      {
        pericopeSetId: 9,
        bookId: 40,
        chapterNumber: 5,
        pericopeNumber: '6_1',
        pericopeTitle: null,
      }
    );
    expect(snap).toMatchObject({
      kind: 'pericope',
      pericopeNumber: '6_1',
      pericopeSetId: 9,
    });
  });

  it('rejects when membership public id does not match caller input', () => {
    const snap = resolveAnchorSnapshot(
      { kind: COMMENT_ANCHOR_KIND.PERICOPE, pericopeNumber: '6_1' },
      assignment,
      null,
      {
        pericopeSetId: 9,
        bookId: 40,
        chapterNumber: 5,
        pericopeNumber: '7_1',
        pericopeTitle: null,
      }
    );
    expect(snap).toEqual({ error: 'INVALID_REFERENCE' });
  });
});

describe('assertStickyConnectionTransition', () => {
  it('forbids unconnected → connected reattach', () => {
    expect(
      assertStickyConnectionTransition(
        COMMENT_CONNECTION_STATE.UNCONNECTED,
        COMMENT_CONNECTION_STATE.CONNECTED
      )
    ).toEqual({ ok: false, reason: 'reattach_forbidden' });
  });

  it('allows connected → unconnected', () => {
    expect(
      assertStickyConnectionTransition(
        COMMENT_CONNECTION_STATE.CONNECTED,
        COMMENT_CONNECTION_STATE.UNCONNECTED
      )
    ).toEqual({ ok: true });
  });
});
