/**
 * Comment-audio keyspace — independent of verse-audio takes / storage_objects reclaim.
 * Reuses low-level R2 Put/Get/Delete helpers by opaque key only.
 *
 * objectId is a pre-upload unique id (UUID), not the DB serial comment id — upload
 * happens before the short write transaction that inserts the row.
 */
export function commentAudioBlobName(
  projectId: number,
  objectId: string,
  contentHash: string
): string {
  return `comments/${projectId}/${objectId}/${contentHash}`;
}

/** Prefix guard so reclaim or verse paths never treat comment keys as takes. */
export function isCommentAudioKey(key: string): boolean {
  return key.startsWith('comments/');
}
