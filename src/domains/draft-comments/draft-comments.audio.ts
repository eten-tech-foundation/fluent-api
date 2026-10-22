/**
 * Comment-audio keyspace — independent of verse-audio takes / storage_objects reclaim.
 * Reuses low-level R2 Put/Get/Delete helpers by opaque key only.
 */
export function commentAudioBlobName(
  projectId: number,
  commentId: number,
  contentHash: string
): string {
  return `comments/${projectId}/${commentId}/${contentHash}`;
}

/** Prefix guard so reclaim or verse paths never treat comment keys as takes. */
export function isCommentAudioKey(key: string): boolean {
  return key.startsWith('comments/');
}
