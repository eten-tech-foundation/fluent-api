/**
 * Draft chapter comments (#458 / mobile #451 #703).
 * Kept outside schema.ts (already at the 1500-line FA-L11 cap).
 *
 * Anchor identity columns are immutable create-time snapshots with NO FK to
 * bible_texts / pericope_sets — source DELETE must not erase retained IDs.
 */
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import {
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { bibles, books, chapter_assignments, projects, users } from './schema';

export const commentBodyKindEnum = pgEnum('comment_body_kind', ['text', 'audio', 'emoji']);
export const commentAnchorKindEnum = pgEnum('comment_anchor_kind', ['verse', 'pericope']);
export const commentConnectionStateEnum = pgEnum('comment_connection_state', [
  'connected',
  'unconnected',
]);

/**
 * Retained chapter comments. Anchor columns are an immutable create-time snapshot;
 * connection_state may move connected → unconnected only (sticky; never reattach).
 * No soft-delete in this slice.
 */
export const chapter_comments = pgTable(
  'chapter_comments',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    chapterAssignmentId: integer('chapter_assignment_id')
      .notNull()
      .references(() => chapter_assignments.id, { onDelete: 'cascade' }),
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    /** Null = root. Replies always reference the root (one-level flatten). */
    parentCommentId: integer('parent_comment_id').references(
      (): AnyPgColumn => chapter_comments.id,
      { onDelete: 'cascade' }
    ),
    bodyKind: commentBodyKindEnum('body_kind').notNull(),
    bodyText: text('body_text'),
    emoji: varchar('emoji', { length: 32 }),
    /** Comment-owned R2 key — never a verse-audio / storage_objects reclaim target. */
    audioStorageKey: varchar('audio_storage_key', { length: 512 }),
    audioContentType: varchar('audio_content_type', { length: 128 }),
    audioByteSize: integer('audio_byte_size'),
    audioDurationSeconds: real('audio_duration_seconds'),
    audioContentHash: varchar('audio_content_hash', { length: 64 }),
    anchorKind: commentAnchorKindEnum('anchor_kind').notNull(),
    anchorBibleId: integer('anchor_bible_id')
      .notNull()
      .references(() => bibles.id),
    anchorBookId: integer('anchor_book_id')
      .notNull()
      .references(() => books.id),
    anchorChapterNumber: integer('anchor_chapter_number').notNull(),
    /** Immutable snapshot — no FK (source DELETE must retain original id). */
    anchorBibleTextId: integer('anchor_bible_text_id'),
    anchorVerseNumber: integer('anchor_verse_number'),
    /** Immutable snapshot — no FK (source DELETE must retain original id). */
    anchorPericopeSetId: integer('anchor_pericope_set_id'),
    anchorPericopeNumber: varchar('anchor_pericope_number', { length: 20 }),
    anchorPericopeTitle: varchar('anchor_pericope_title', { length: 500 }),
    connectionState: commentConnectionStateEnum('connection_state').notNull().default('connected'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_chapter_comments_assignment_created').on(
      table.chapterAssignmentId,
      table.createdAt,
      table.id
    ),
    index('idx_chapter_comments_project_connection').on(table.projectId, table.connectionState),
    index('idx_chapter_comments_parent').on(table.parentCommentId),
    index('idx_chapter_comments_author_assignment').on(
      table.chapterAssignmentId,
      table.authorUserId
    ),
  ]
);

export const chapter_comment_reactions = pgTable(
  'chapter_comment_reactions',
  {
    id: serial('id').primaryKey(),
    commentId: integer('comment_id')
      .notNull()
      .references(() => chapter_comments.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_chapter_comment_reaction_user').on(table.commentId, table.userId),
    index('idx_chapter_comment_reactions_comment').on(table.commentId),
  ]
);

export type ChapterComment = typeof chapter_comments.$inferSelect;
export type NewChapterComment = typeof chapter_comments.$inferInsert;
export type ChapterCommentReaction = typeof chapter_comment_reactions.$inferSelect;
