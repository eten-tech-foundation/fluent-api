import { describe, expect, it } from 'vitest';

import { commentAudioBlobName, isCommentAudioKey } from './draft-comments.audio';

describe('comment audio keyspace', () => {
  it('uses comments/ prefix with opaque object id distinct from verse-audio keys', () => {
    const key = commentAudioBlobName(3, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'abc');
    expect(key).toBe('comments/3/a1b2c3d4-e5f6-7890-abcd-ef1234567890/abc');
    expect(isCommentAudioKey(key)).toBe(true);
    expect(isCommentAudioKey('unit-12/text-3401/abc')).toBe(false);
  });
});
