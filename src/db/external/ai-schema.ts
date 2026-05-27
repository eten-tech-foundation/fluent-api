/**
 * EXTERNALLY OWNED — `ai` schema stubs for Drizzle type safety.
 *
 * These tables live in the `ai` schema and are owned by `fluent-ai`
 * (Alembic-managed). `fluent-api` needs read/write access to them via
 * `role_web_data` / `role_pgboss_user` grants, so we maintain lightweight
 * Drizzle stubs here.
 *
 * DO NOT hand-edit column definitions. When `fluent-ai` changes the
 * `ai` schema, regenerate this file from the database:
 *
 *   npx drizzle-kit introspect --tables='ai.*' --out=./src/db/external/ai-schema.ts
 *
 * Then review the diff and commit.
 */
import {
  boolean,
  index,
  integer,
  pgSchema,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { z } from '@hono/zod-openapi';
import { createSchemaFactory } from 'drizzle-zod';

import { bibles, bible_texts, project_units, users } from '@/db/schema';

export const aiSchema = pgSchema('ai');

export const ai_suggestion_jobs = aiSchema.table(
  'ai_suggestion_jobs',
  {
    id: serial('id').primaryKey(),
    projectUnitId: integer('project_unit_id')
      .notNull()
      .references(() => project_units.id, { onDelete: 'cascade' }),
    bibleId: integer('bible_id')
      .notNull()
      .references(() => bibles.id),
    bookCode: varchar('book_code', { length: 50 }).notNull(),
    chapterNumber: integer('chapter_number').notNull(),
    verseStart: integer('verse_start').notNull(),
    verseEnd: integer('verse_end').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('queued'),
    retryCount: integer('retry_count').notNull().default(0),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_ai_jobs_project_unit').on(table.projectUnitId),
    index('idx_ai_jobs_status').on(table.status),
    uniqueIndex('uq_ai_jobs_range').on(
      table.projectUnitId,
      table.bibleId,
      table.bookCode,
      table.chapterNumber,
      table.verseStart,
      table.verseEnd
    ),
  ]
);

export const ai_suggestions = aiSchema.table(
  'ai_suggestions',
  {
    id: serial('id').primaryKey(),
    bibleTextId: integer('bible_text_id')
      .notNull()
      .references(() => bible_texts.id, { onDelete: 'cascade' }),
    projectUnitId: integer('project_unit_id')
      .notNull()
      .references(() => project_units.id, { onDelete: 'cascade' }),
    suggestedText: text('suggested_text').notNull(),
    modelInfo: varchar('model_info', { length: 100 }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    index('idx_ai_suggestions_bible_text').on(table.bibleTextId),
    uniqueIndex('uq_ai_suggestions_per_text_unit').on(table.bibleTextId, table.projectUnitId),
  ]
);

export const ai_suggestion_usage_log = aiSchema.table(
  'ai_suggestion_usage_log',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bibleTextId: integer('bible_text_id')
      .notNull()
      .references(() => bible_texts.id, { onDelete: 'cascade' }),
    projectUnitId: integer('project_unit_id')
      .notNull()
      .references(() => project_units.id, { onDelete: 'cascade' }),
    wasUsed: boolean('was_used').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_ai_usage_user').on(table.userId),
    index('idx_ai_usage_project_unit').on(table.projectUnitId),
    uniqueIndex('uq_ai_usage_user_text').on(table.userId, table.bibleTextId),
  ]
);

const { createInsertSchema, createSelectSchema } = createSchemaFactory({
  zodInstance: z,
});

export const selectAiSuggestionJobsSchema = createSelectSchema(ai_suggestion_jobs);
export const selectAiSuggestionsSchema = createSelectSchema(ai_suggestions);
export const selectAiSuggestionUsageLogSchema = createSelectSchema(ai_suggestion_usage_log);

export const insertAiSuggestionJobsSchema = createInsertSchema(ai_suggestion_jobs, {
  projectUnitId: (schema) => schema.int(),
  bibleId: (schema) => schema.int(),
  bookCode: (schema) => schema.min(1),
  chapterNumber: (schema) => schema.int().min(1),
  verseStart: (schema) => schema.int().min(1),
  verseEnd: (schema) => schema.int().min(1),
})
  .required({
    projectUnitId: true,
    bibleId: true,
    bookCode: true,
    chapterNumber: true,
    verseStart: true,
    verseEnd: true,
  })
  .omit({
    id: true,
    status: true,
    retryCount: true,
    errorMessage: true,
    createdAt: true,
    updatedAt: true,
  });

export const insertAiSuggestionsSchema = createInsertSchema(ai_suggestions, {
  bibleTextId: (schema) => schema.int(),
  projectUnitId: (schema) => schema.int(),
  suggestedText: (schema) => schema.min(1),
})
  .required({ bibleTextId: true, projectUnitId: true, suggestedText: true })
  .omit({ id: true, createdAt: true });

export const insertAiSuggestionUsageLogSchema = createInsertSchema(ai_suggestion_usage_log, {
  userId: (schema) => schema.int(),
  bibleTextId: (schema) => schema.int(),
  projectUnitId: (schema) => schema.int(),
})
  .required({ userId: true, bibleTextId: true, projectUnitId: true, wasUsed: true })
  .omit({ id: true, createdAt: true });

export const patchAiSuggestionJobsSchema = insertAiSuggestionJobsSchema.partial();
export const patchAiSuggestionsSchema = insertAiSuggestionsSchema.partial();
export const patchAiSuggestionUsageLogSchema = insertAiSuggestionUsageLogSchema.partial();
