import { describe, expect, it } from 'vitest';

import { commentAudioBlobName, isCommentAudioKey } from './draft-comments.audio';

describe('comment audio keyspace', () => {
  it('uses comments/ prefix distinct from verse-audio unit-/text- keys', () => {
    expect(commentAudioBlobName(3, 99, 'abc')).toBe('comments/3/99/abc');
    expect(isCommentAudioKey('comments/3/99/abc')).toBe(true);
    expect(isCommentAudioKey('unit-12/text-3401/abc')).toBe(false);
  });
});
