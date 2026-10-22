import type { ChapterComment, ChapterCommentReaction } from '@/db/draft-comments.schema';

import { generateAudioDownloadUrl, isAudioStorageAvailable } from '@/lib/audio-storage';

import type { ChapterCommentResponse } from './draft-comments.types';

import { isCommentAudioKey } from './draft-comments.audio';
import * as repo from './draft-comments.repository';
import { COMMENT_BODY_KIND } from './draft-comments.types';

function displayName(author: {
  firstName: string | null;
  lastName: string | null;
  username: string;
}): string {
  const full = [author.firstName, author.lastName].filter(Boolean).join(' ').trim();
  return full || author.username;
}

function summarizeReactions(
  reactions: ChapterCommentReaction[],
  currentUserId: number
): { reactions: Array<{ emoji: string; count: number }>; currentUserReaction: string | null } {
  const counts = new Map<string, number>();
  let currentUserReaction: string | null = null;
  for (const reaction of reactions) {
    counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
    if (reaction.userId === currentUserId) currentUserReaction = reaction.emoji;
  }
  return {
    reactions: [...counts.entries()]
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((a, b) => a.emoji.localeCompare(b.emoji)),
    currentUserReaction,
  };
}

export async function mapCommentRow(
  row: ChapterComment,
  reactions: ChapterCommentReaction[],
  currentUserId: number,
  roleDisplay: string | null
): Promise<ChapterCommentResponse> {
  const author = await repo.findAuthorDisplay(row.authorUserId);
  const summary = summarizeReactions(reactions, currentUserId);
  let audio: ChapterCommentResponse['audio'] = null;
  if (row.bodyKind === COMMENT_BODY_KIND.AUDIO && row.audioStorageKey) {
    let downloadUrl: string | null = null;
    if (isAudioStorageAvailable() && isCommentAudioKey(row.audioStorageKey)) {
      try {
        downloadUrl = await generateAudioDownloadUrl(row.audioStorageKey);
      } catch {
        downloadUrl = null;
      }
    }
    audio = {
      contentType: row.audioContentType ?? 'application/octet-stream',
      byteSize: row.audioByteSize ?? 0,
      durationSeconds: row.audioDurationSeconds,
      contentHash: row.audioContentHash ?? '',
      downloadUrl,
    };
  }
  return {
    id: row.id,
    projectId: row.projectId,
    chapterAssignmentId: row.chapterAssignmentId,
    parentCommentId: row.parentCommentId,
    author: {
      userId: row.authorUserId,
      displayName: author ? displayName(author) : `user-${row.authorUserId}`,
      roleDisplay,
    },
    createdAt: row.createdAt.toISOString(),
    bodyKind: row.bodyKind,
    text: row.bodyText,
    emoji: row.emoji,
    audio,
    anchor: {
      kind: row.anchorKind,
      bibleId: row.anchorBibleId,
      bookId: row.anchorBookId,
      chapterNumber: row.anchorChapterNumber,
      bibleTextId: row.anchorBibleTextId,
      verseNumber: row.anchorVerseNumber,
      pericopeSetId: row.anchorPericopeSetId,
      pericopeNumber: row.anchorPericopeNumber,
      pericopeTitle: row.anchorPericopeTitle,
    },
    connectionState: row.connectionState,
    reactions: summary.reactions,
    currentUserReaction: summary.currentUserReaction,
  };
}
