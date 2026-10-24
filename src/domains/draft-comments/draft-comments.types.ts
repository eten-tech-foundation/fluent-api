import { z } from '@hono/zod-openapi';

/** Engineering default — mirrors verse-audio allow-list; not a product permission policy. */
export const MAX_COMMENT_AUDIO_BYTES = 30 * 1024 * 1024;

export const ALLOWED_COMMENT_AUDIO_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/webm',
  'audio/wav',
  'audio/ogg',
]);

export const COMMENT_BODY_KIND = {
  TEXT: 'text',
  AUDIO: 'audio',
  EMOJI: 'emoji',
} as const;

export const COMMENT_ANCHOR_KIND = {
  VERSE: 'verse',
  PERICOPE: 'pericope',
} as const;

export const COMMENT_CONNECTION_STATE = {
  CONNECTED: 'connected',
  UNCONNECTED: 'unconnected',
} as const;

const commentEmojiSchema = z.string().trim().min(1).max(32);
const commentBodyTextSchema = z.string().trim().min(1).max(10_000);

const commentAnchorVerseSchema = z.object({
  kind: z.literal(COMMENT_ANCHOR_KIND.VERSE),
  bibleTextId: z.number().int().positive(),
});

const commentAnchorPericopeSchema = z.object({
  kind: z.literal(COMMENT_ANCHOR_KIND.PERICOPE),
  pericopeNumber: z.string().trim().min(1).max(20),
  /** Optional create-time hint; server snapshots set id + title from project membership. */
  pericopeSetId: z.number().int().positive().optional(),
});

export const commentAnchorInputSchema = z.discriminatedUnion('kind', [
  commentAnchorVerseSchema,
  commentAnchorPericopeSchema,
]);

const textBodySchema = z.object({
  kind: z.literal(COMMENT_BODY_KIND.TEXT),
  text: commentBodyTextSchema,
});

const emojiBodySchema = z.object({
  kind: z.literal(COMMENT_BODY_KIND.EMOJI),
  emoji: commentEmojiSchema,
});

/** JSON create for text/emoji. Audio uses multipart under the comments resource. */
const createCommentJsonBodySchema = z.discriminatedUnion('kind', [textBodySchema, emojiBodySchema]);

export const createTopLevelCommentRequestSchema = z.object({
  anchor: commentAnchorInputSchema,
  body: createCommentJsonBodySchema,
});

export const createReplyRequestSchema = z.object({
  /** Target comment — may be root or a first-level reply (flattened to root). */
  replyToCommentId: z.number().int().positive(),
  body: createCommentJsonBodySchema,
});

export const setReactionRequestSchema = z.object({
  emoji: commentEmojiSchema,
});

const commentAuthorSchema = z.object({
  userId: z.number().int().positive(),
  displayName: z.string(),
  roleDisplay: z.string().nullable(),
});

const commentAnchorSnapshotSchema = z.object({
  kind: z.enum([COMMENT_ANCHOR_KIND.VERSE, COMMENT_ANCHOR_KIND.PERICOPE]),
  bibleId: z.number().int().positive(),
  bookId: z.number().int().positive(),
  chapterNumber: z.number().int().positive(),
  bibleTextId: z.number().int().positive().nullable(),
  verseNumber: z.number().int().positive().nullable(),
  pericopeSetId: z.number().int().positive().nullable(),
  pericopeNumber: z.string().nullable(),
  pericopeTitle: z.string().nullable(),
});

const commentAudioRefSchema = z.object({
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
  contentHash: z.string(),
  /** Present when storage is available; omit/null if download URL cannot be minted. */
  downloadUrl: z.string().url().nullable(),
});

const commentReactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number().int().nonnegative(),
});

export const chapterCommentResponseSchema = z.object({
  id: z.number().int().positive(),
  projectId: z.number().int().positive(),
  chapterAssignmentId: z.number().int().positive(),
  parentCommentId: z.number().int().positive().nullable(),
  author: commentAuthorSchema,
  createdAt: z.string().datetime(),
  bodyKind: z.enum([COMMENT_BODY_KIND.TEXT, COMMENT_BODY_KIND.AUDIO, COMMENT_BODY_KIND.EMOJI]),
  text: z.string().nullable(),
  emoji: z.string().nullable(),
  audio: commentAudioRefSchema.nullable(),
  anchor: commentAnchorSnapshotSchema,
  connectionState: z.enum([
    COMMENT_CONNECTION_STATE.CONNECTED,
    COMMENT_CONNECTION_STATE.UNCONNECTED,
  ]),
  reactions: z.array(commentReactionSummarySchema),
  currentUserReaction: z.string().nullable(),
});

export const listChapterCommentsResponseSchema = z.object({
  connected: z.array(chapterCommentResponseSchema),
  unconnected: z.array(chapterCommentResponseSchema),
});

/** Approved #703 semantics. */
export const chapterCommentAggregateSchema = z.object({
  chapterAssignmentId: z.number().int().positive(),
  commentCount: z.number().int().nonnegative(),
  currentUserHasCommented: z.boolean(),
});

export type CreateTopLevelCommentRequest = z.infer<typeof createTopLevelCommentRequestSchema>;
export type CreateReplyRequest = z.infer<typeof createReplyRequestSchema>;
export type ChapterCommentResponse = z.infer<typeof chapterCommentResponseSchema>;
export type ListChapterCommentsResponse = z.infer<typeof listChapterCommentsResponseSchema>;
export type ChapterCommentAggregate = z.infer<typeof chapterCommentAggregateSchema>;
export type CommentAnchorInput = z.infer<typeof commentAnchorInputSchema>;
