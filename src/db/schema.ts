/* eslint-disable max-lines */
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Json } from 'drizzle-zod';

import { z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  json,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { createSchemaFactory } from 'drizzle-zod';
export const userStatusEnum = pgEnum('user_status', ['invited', 'verified', 'inactive']);
export const scriptDirectionEnum = pgEnum('script_direction', ['ltr', 'rtl']);
export const projectStatusEnum = pgEnum('project_status', [
  'not_started',
  'in_progress',
  'completed',
]);
export const projectAssignmentStatusEnum = pgEnum('project_assignment_status', [
  'active',
  'not_assigned',
]);
export const chapterStatusEnum = pgEnum('chapter_status', [
  'not_started',
  'draft',
  'peer_check',
  'community_review',
  'linguist_check',
  'theological_check',
  'consultant_check',
  'complete',
]);
export const assignmentRoleEnum = pgEnum('assignment_role', ['drafter', 'peer_checker']);
export const roles = pgTable('roles', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const organizations = pgTable('organizations', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ─── BetterAuth Core Tables ──────────────────────────────────────────────────

export const authUser = pgTable('auth_user', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: varchar('image', { length: 255 }),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const authSession = pgTable('auth_session', {
  id: varchar('id', { length: 36 }).primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: varchar('token', { length: 255 }).notNull().unique(),
  ipAddress: varchar('ip_address', { length: 255 }),
  userAgent: varchar('user_agent'),
  userId: varchar('user_id', { length: 36 })
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  // Durably flags mobile sessions at sign-in time.
  // Avoids per-request UA re-parsing for rolling logic.
  isMobile: boolean('is_mobile').notNull().default(false),
  activeOrgId: integer('active_org_id').references(() => organizations.id),
});

export const authAccount = pgTable('auth_account', {
  id: varchar('id', { length: 36 }).primaryKey(),
  accountId: varchar('account_id', { length: 255 }).notNull(),
  providerId: varchar('provider_id', { length: 255 }).notNull(),
  userId: varchar('user_id', { length: 36 })
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  accessToken: varchar('access_token'),
  refreshToken: varchar('refresh_token'),
  idToken: varchar('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: varchar('scope', { length: 255 }),
  password: varchar('password', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const authVerification = pgTable('auth_verification', {
  id: varchar('id', { length: 36 }).primaryKey(),
  identifier: varchar('identifier', { length: 255 }).notNull(),
  value: varchar('value', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const authAuditLog = pgTable(
  'auth_audit_log',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id', { length: 36 }).references(() => authUser.id, {
      onDelete: 'set null',
    }),
    event: varchar('event', { length: 100 }).notNull(),
    ipAddress: varchar('ip_address', { length: 255 }),
    userAgent: varchar('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_audit_log_user').on(table.userId),
    index('idx_audit_log_event').on(table.event),
    index('idx_audit_log_created').on(table.createdAt),
  ]
);

// ─── App Domain Tables ───────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  authUserId: varchar('auth_user_id', { length: 36 }).references(() => authUser.id, {
    onDelete: 'set null',
  }),
  username: varchar('username', { length: 100 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),

  status: userStatusEnum('status').notNull().default('invited'),
  lastActiveOrgId: integer('last_active_org_id').references(() => organizations.id),
  createdBy: integer('created_by').references((): AnyPgColumn => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const languages = pgTable('languages', {
  id: serial('id').primaryKey(),
  langName: varchar('lang_name', { length: 100 }).notNull(),
  langNameLocalized: varchar('lang_name_localized', { length: 100 }),
  langCodeIso6393: varchar('lang_code_iso_639_3', { length: 3 }),
  scriptDirection: scriptDirectionEnum('script_direction').default('ltr'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ─── Pericope Tables ─────────────────────────────────────────────────────────

export const pericope_sets = pgTable('pericope_sets', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 50 }).notNull().unique(), // 'FCBH' | 'FIA'
  description: varchar('description', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ─────────────────────────────────────────────────────────────────────────────

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  sourceLanguage: integer('source_language')
    .notNull()
    .references(() => languages.id),
  targetLanguage: integer('target_language')
    .notNull()
    .references(() => languages.id),
  organization: integer('organization')
    .notNull()
    .references(() => organizations.id),
  isActive: boolean('is_active').default(true),
  status: projectAssignmentStatusEnum('status').notNull().default('not_assigned'),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
  metadata: jsonb('metadata').$type<Json>().notNull().default({}),
  // Nullable — existing projects have no pericope set; new projects may select one
  pericopeSetId: integer('pericope_set_id').references(() => pericope_sets.id),
});

export const bibles = pgTable('bibles', {
  id: serial('id').primaryKey(),
  languageId: integer('language_id')
    .notNull()
    .references(() => languages.id),
  name: varchar('name', { length: 255 }).notNull().unique(),
  abbreviation: varchar('abbreviation', { length: 50 }).notNull().unique(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const books = pgTable('books', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 50 }).notNull(),
  eng_display_name: varchar('eng_display_name', { length: 255 }).notNull(),
});

export const pericope_verses = pgTable(
  'pericope_verses',
  {
    id: serial('id').primaryKey(),
    pericopeSetId: integer('pericope_set_id')
      .notNull()
      .references(() => pericope_sets.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id),
    chapterNumber: integer('chapter_number').notNull(),
    verseNumber: integer('verse_number').notNull(),
    section: integer('section'), // fcbh_section only; NULL for FIA
    pericopeNumber: varchar('pericope_number', { length: 20 }).notNull(), // '1', '4a', '4b'
    pericopeTitle: varchar('pericope_title', { length: 500 }), // fia_pericope_title; NULL for FCBH
  },
  (table) => [
    // verse lookup: given (set, book, chapter) find a verse's pericope
    // unique: a verse can only belong to one pericope within a set
    uniqueIndex('idx_pericope_verses_set_book_chapter_verse').on(
      table.pericopeSetId,
      table.bookId,
      table.chapterNumber,
      table.verseNumber
    ),
    // range lookup: given (set, book, pericope_number) fetch all verses in that pericope
    index('idx_pericope_verses_set_book_pericope').on(
      table.pericopeSetId,
      table.bookId,
      table.pericopeNumber,
      table.chapterNumber,
      table.verseNumber
    ),
  ]
);

export const bible_books = pgTable('bible_books', {
  bibleId: integer('bible_id')
    .notNull()
    .references(() => bibles.id),
  bookId: integer('book_id')
    .notNull()
    .references(() => books.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const project_units = pgTable('project_units', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  status: projectStatusEnum('status').notNull().default('not_started'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const project_unit_bible_books = pgTable('project_unit_bible_books', {
  projectUnitId: integer('project_unit_id')
    .notNull()
    .references(() => project_units.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  bibleId: integer('bible_id')
    .notNull()
    .references(() => bibles.id),
  bookId: integer('book_id')
    .notNull()
    .references(() => books.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const bible_texts = pgTable(
  'bible_texts',
  {
    id: serial('id').primaryKey(),
    bibleId: integer('bible_id')
      .notNull()
      .references(() => bibles.id),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id),
    chapterNumber: integer('chapter_number').notNull(),
    verseNumber: integer('verse_number').notNull(),
    text: varchar('text').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_bible_texts_bible_book_chapter').on(
      table.bibleId,
      table.bookId,
      table.chapterNumber
    ),
    index('idx_bible_texts_bible_book_chapter_verse').on(
      table.bibleId,
      table.bookId,
      table.chapterNumber,
      table.verseNumber
    ),
  ]
);

export const translated_verses = pgTable(
  'translated_verses',
  {
    id: serial('id').primaryKey(),
    projectUnitId: integer('project_unit_id')
      .notNull()
      .references(() => project_units.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    content: varchar('content').notNull(),
    bibleTextId: integer('bible_text_id')
      .notNull()
      .references(() => bible_texts.id),
    assignedUserId: integer('assigned_user_id').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_translated_verse_per_bible_text').on(table.projectUnitId, table.bibleTextId),
  ]
);

export const chapter_assignments = pgTable(
  'chapter_assignments',
  {
    id: serial('id').primaryKey(),
    projectUnitId: integer('project_unit_id')
      .notNull()
      .references(() => project_units.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    bibleId: integer('bible_id')
      .notNull()
      .references(() => bibles.id),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id),
    chapterNumber: integer('chapter_number').notNull(),
    assignedUserId: integer('assigned_user_id').references(() => users.id),
    peerCheckerId: integer('peer_checker_id').references(() => users.id),
    status: chapterStatusEnum('chapter_status').notNull().default('not_started'),
    isAiEnabled: boolean('is_ai_enabled').default(false).notNull(),
    submittedTime: timestamp('submitted_time'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_chapter_assignment_per_chapter').on(
      table.projectUnitId,
      table.bibleId,
      table.bookId,
      table.chapterNumber
    ),
    index('idx_chapter_assignments_assigned_user').on(table.assignedUserId),
    index('idx_chapter_assignments_peer_checker_status').on(table.peerCheckerId, table.status),
    index('idx_chapter_assignments_project_unit').on(table.projectUnitId),
  ]
);

export const chapter_assignment_snapshots = pgTable(
  'chapter_assignment_snapshots',
  {
    id: serial('id').primaryKey(),
    chapterAssignmentId: integer('chapter_assignment_id')
      .notNull()
      .references(() => chapter_assignments.id, { onDelete: 'cascade' }),
    status: chapterStatusEnum('status').notNull(),
    assignedUserId: integer('assigned_user_id').references(() => users.id),
    content: json('content').$type<Json>().notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    index('idx_ca_snapshots_assignment').on(table.chapterAssignmentId),
    index('idx_ca_snapshots_user').on(table.assignedUserId),
  ]
);

export const chapter_assignment_assigned_user_history = pgTable(
  'chapter_assignment_assigned_user_history',
  {
    id: serial('id').primaryKey(),
    chapterAssignmentId: integer('chapter_assignment_id')
      .notNull()
      .references(() => chapter_assignments.id, { onDelete: 'cascade' }),
    assignedUserId: integer('assigned_user_id')
      .notNull()
      .references(() => users.id),
    role: assignmentRoleEnum('role').notNull(),
    status: chapterStatusEnum('status').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    index('idx_ca_user_history_assignment').on(table.chapterAssignmentId),
    index('idx_ca_user_history_user').on(table.assignedUserId),
  ]
);

export const chapter_assignment_status_history = pgTable(
  'chapter_assignment_status_history',
  {
    id: serial('id').primaryKey(),
    chapterAssignmentId: integer('chapter_assignment_id')
      .notNull()
      .references(() => chapter_assignments.id, { onDelete: 'cascade' }),
    status: chapterStatusEnum('status').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [index('idx_ca_status_history_assignment').on(table.chapterAssignmentId)]
);

export const editorStateResourcesSchema = z
  .object({
    activeResource: z.string().min(1),
    bookCode: z.string().min(1),
    chapterNumber: z.number(),
    verseNumber: z.number(),
    languageCode: z.string().min(1),
    tabStatus: z.boolean(),
    // ── Repeated Word Check additions (optional; old rows parse unchanged — no migration) ──
    // Which left-panel tab is active (Resources vs Checks).
    activeLeftTab: z.enum(['resources', 'checks']).optional(),
    // Per-occurrence ignore rules for repeated-word findings, keyed by
    // "{snt_id}|{repeated_word}|{ordinal}" (see fluent-web useResolvedFindings).
    checkOccurrenceRules: z.record(z.string(), z.enum(['suppress', 'surface'])).optional(),
  })
  .nullable();

// ─── User-global settings (Fluent preference store; W2/W7) ───────────────────
// One row per user, a single Zod-typed JSONB blob. `.catch({})` so unknown/old
// shapes parse as empty rather than throwing (W8). Surfaced via GET/PUT /self/settings.
//
// ⚠️ IMPLEMENTATION NOTE — full-replace today; ADD MERGE BEFORE A SECOND KEY ⚠️
// `PUT /self/settings` is a deliberate **full-replace** of the whole blob
// (last-writer-wins; no PATCH/ETags — §8.1/§8.3). That is safe ONLY while there
// is exactly ONE key (`checkIgnoredWordPairs`): the client just GETs, edits the
// one key, and PUTs the whole blob back. There is no server-side merge.
//
// Because this is a plain `z.object`, the write schema **strips any unknown
// key**, so a sibling setting cannot even reach the store today — which means
// this object is the *only* gate: you literally cannot introduce a second
// setting without editing THIS schema. So, before adding any second key here,
// you MUST also make the write path merge instead of replace, or the
// full-replace PUT will silently drop whichever key the caller didn't send.
// Recommended at that point (in `self-settings.service.upsertSettings`):
//   1. GET the existing stored blob for the user.
//   2. Shallow-merge the incoming keys over it (set provided keys; treat an
//      explicit `null` value as "delete this key"; leave absent keys untouched).
//   3. Persist the merged blob.
// Until then, keep the single-key full-replace contract.
// The bare object shape (no `.catch`). This is also the OpenAPI-facing schema:
// the `.catch({})` wrapper below produces a `ZodCatch` node that
// @asteasolutions/zod-to-openapi (under @hono/zod-openapi) cannot render — it
// throws "Unknown zod object type" while building the spec, which 500s `/doc`.
// The `.catch` only changes behaviour on INVALID input (see `userSettingsSchema`);
// it adds/removes no fields, so the documented shape is identical either way.
// Anything exposed on the OpenAPI surface must therefore embed THIS schema, not
// the `.catch` variant. (Guarded by src/routes/doc.route.test.ts.)
export const userSettingsObjectSchema = z.object({
  // Global "Ignore Everywhere" rules, keyed by the NFC-normalized repeated-word
  // pair string (e.g. "the the"); applies across all of the user's projects.
  checkIgnoredWordPairs: z.record(z.string(), z.enum(['suppress', 'surface'])).optional(),
});

// Read/storage schema: `.catch({})` so unknown/old shapes parse as empty rather
// than throwing (W8). Use this when reading rows back from the DB. NOTE: this is
// a `ZodCatch` — keep it OFF the OpenAPI surface (see the note on
// `userSettingsObjectSchema` above); expose the plain object shape there instead.
export const userSettingsSchema = userSettingsObjectSchema.catch({});

// Strict write schema (no `.catch`): a malformed *incoming* PUT body is rejected
// (surfaced as a 422 VALIDATION_ERROR — a well-formed request whose contents fail
// schema validation; see self-settings.service.upsertSettings) instead of being
// silently swallowed.
export const userSettingsWriteSchema = userSettingsObjectSchema;

export const user_chapter_assignment_editor_state = pgTable(
  'user_chapter_assignment_editor_state',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chapterAssignmentId: integer('chapter_assignment_id')
      .notNull()
      .references(() => chapter_assignments.id, { onDelete: 'cascade' }),
    resources: jsonb('resources').$type<z.infer<typeof editorStateResourcesSchema>>(),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_user_chapter_assignment_editor_state').on(
      table.userId,
      table.chapterAssignmentId
    ),
  ]
);

export const user_settings = pgTable('user_settings', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<z.infer<typeof userSettingsSchema>>(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const project_users = pgTable(
  'project_users',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index('idx_project_users_project').on(table.projectId),
    index('idx_project_users_user').on(table.userId),
  ]
);
export const permissions = pgTable('permissions', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: varchar('description', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const role_permissions = pgTable(
  'role_permissions',
  {
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: integer('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })]
);

export const user_roles = pgTable(
  'user_roles',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: integer('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_user_role_grant').on(
      table.userId,
      sql`COALESCE(${table.orgId}, -1)`,
      sql`COALESCE(${table.projectId}, -1)`,
      table.roleId
    ),
    index('idx_user_roles_user').on(table.userId),
    index('idx_user_roles_org').on(table.orgId),
    index('idx_user_roles_project').on(table.projectId),
  ]
);

export const active_chapter_editors = pgTable(
  'active_chapter_editors',
  {
    chapterAssignmentId: integer('chapter_assignment_id')
      .notNull()
      .references(() => chapter_assignments.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    lastHeartbeat: timestamp('last_heartbeat').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chapterAssignmentId, table.userId] }),
    index('idx_active_editors_chapter').on(table.chapterAssignmentId),
  ]
);

export const ai_suggestions = pgTable(
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

export const ai_suggestion_usage_log = pgTable(
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
    uniqueIndex('uq_ai_usage_user_text').on(table.userId, table.bibleTextId, table.projectUnitId),
  ]
);

const { createInsertSchema, createSelectSchema } = createSchemaFactory({
  zodInstance: z,
});

export const selectUsersSchema = createSelectSchema(users);
export const selectRolesSchema = createSelectSchema(roles);
export const selectOrganizationsSchema = createSelectSchema(organizations);
export const selectLanguagesSchema = createSelectSchema(languages);
export const selectProjectsSchema = createSelectSchema(projects);
export const selectBiblesSchema = createSelectSchema(bibles);
export const selectBooksSchema = createSelectSchema(books);
export const selectBibleBooksSchema = createSelectSchema(bible_books);
export const selectProjectUnitsSchema = createSelectSchema(project_units);
export const selectProjectUnitBibleBooksSchema = createSelectSchema(project_unit_bible_books);
export const selectBibleTextsSchema = createSelectSchema(bible_texts);
export const selectTranslatedVersesSchema = createSelectSchema(translated_verses);
export const selectChapterAssignmentsSchema = createSelectSchema(chapter_assignments);
export const selectChapterAssignmentSnapshotsSchema = createSelectSchema(
  chapter_assignment_snapshots
);
export const selectChapterAssignmentAssignedUserHistorySchema = createSelectSchema(
  chapter_assignment_assigned_user_history
);
export const selectChapterAssignmentStatusHistorySchema = createSelectSchema(
  chapter_assignment_status_history
);
export const selectUserChapterAssignmentEditorStateSchema = createSelectSchema(
  user_chapter_assignment_editor_state
);
export const selectProjectUsersSchema = createSelectSchema(project_users);
export const selectUserSettingsSchema = createSelectSchema(user_settings);
export const selectPermissionsSchema = createSelectSchema(permissions);
export const selectRolePermissionsSchema = createSelectSchema(role_permissions);
export const selectActiveChapterEditorsSchema = createSelectSchema(active_chapter_editors);
export const selectUserRolesSchema = createSelectSchema(user_roles);
export const selectAiSuggestionsSchema = createSelectSchema(ai_suggestions);
export const selectAiSuggestionUsageLogSchema = createSelectSchema(ai_suggestion_usage_log);

export const insertUsersSchema = createInsertSchema(users, {
  username: (schema) => schema.min(1).max(100),
  email: (schema) => schema.email().max(255),
  firstName: (schema) => schema.max(100).optional(),
  lastName: (schema) => schema.max(100).optional(),
  status: z.enum(['invited', 'verified', 'inactive']).default('invited'),
})
  .required({
    username: true,
    email: true,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export const insertRolesSchema = createInsertSchema(roles, {
  name: (schema) => schema.min(1).max(255),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertOrganizationsSchema = createInsertSchema(organizations, {
  name: (schema) => schema.min(1).max(100),
})
  .required({ name: true })
  .omit({ id: true, createdAt: true, updatedAt: true });

export const insertLanguagesSchema = createInsertSchema(languages, {
  langName: (schema) => schema.max(100).optional(),
  langNameLocalized: (schema) => schema.max(100).optional(),
  langCodeIso6393: (schema) => schema.max(3).optional(),
  scriptDirection: z.enum(['ltr', 'rtl']).default('ltr'),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertProjectsSchema = createInsertSchema(projects, {
  name: (schema) => schema.min(1).max(255),
  sourceLanguage: (schema) => schema.int(),
  targetLanguage: (schema) => schema.int(),
  organization: (schema) => schema.int(),
  isActive: (schema) => schema.default(true),
  status: z.enum(['active', 'not_assigned']).default('not_assigned'),
})
  .required({
    name: true,
    sourceLanguage: true,
    targetLanguage: true,
    organization: true,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export const insertProjectUnitsSchema = createInsertSchema(project_units, {
  projectId: (schema) => schema.int(),
  status: z.enum(['not_started', 'in_progress', 'completed']).default('not_started'),
})
  .required({
    projectId: true,
    status: true,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export const insertProjectUnitBibleBooksSchema = createInsertSchema(project_unit_bible_books, {
  projectUnitId: (schema) => schema.int(),
  bibleId: (schema) => schema.int(),
  bookId: (schema) => schema.int(),
})
  .required({
    projectUnitId: true,
    bibleId: true,
    bookId: true,
  })
  .omit({
    createdAt: true,
    updatedAt: true,
  });

export const insertBiblesSchema = createInsertSchema(bibles, {
  languageId: (schema) => schema.int(),
  name: (schema) => schema.min(1).max(255),
  abbreviation: (schema) => schema.min(1).max(50),
})
  .required({
    languageId: true,
    name: true,
    abbreviation: true,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export const insertBibleBooksSchema = createInsertSchema(bible_books)
  .required({
    bibleId: true,
    bookId: true,
  })
  .omit({
    createdAt: true,
    updatedAt: true,
  });

export const insertBibleTextsSchema = createInsertSchema(bible_texts, {
  bibleId: (schema) => schema.int(),
  bookId: (schema) => schema.int(),
  chapterNumber: (schema) => schema.int().min(1),
  verseNumber: (schema) => schema.int().min(1),
  text: (schema) => schema.min(1),
})
  .required({
    bibleId: true,
    bookId: true,
    chapterNumber: true,
    verseNumber: true,
    text: true,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export const insertTranslatedVersesSchema = createInsertSchema(translated_verses, {
  projectUnitId: (schema) => schema.int(),
  content: (schema) => schema.min(0),
  bibleTextId: (schema) => schema.int(),
  assignedUserId: (schema) => schema.int().optional(),
})
  .required({
    projectUnitId: true,
    content: true,
    bibleTextId: true,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export const insertChapterAssignmentsSchema = createInsertSchema(chapter_assignments, {
  projectUnitId: (schema) => schema.int(),
  bibleId: (schema) => schema.int(),
  bookId: (schema) => schema.int(),
  chapterNumber: (schema) => schema.int().min(1),
  assignedUserId: (schema) => schema.int(),
  peerCheckerId: (schema) => schema.int(),
})
  .required({
    projectUnitId: true,
    bibleId: true,
    bookId: true,
    chapterNumber: true,
    assignedUserId: true,
    peerCheckerId: true,
  })
  .omit({
    id: true,
    status: true,
    createdAt: true,
    updatedAt: true,
  });

export const insertChapterAssignmentSnapshotsSchema = createInsertSchema(
  chapter_assignment_snapshots,
  {
    chapterAssignmentId: (schema) => schema.int(),
    assignedUserId: (schema) => schema.int().optional(),
  }
)
  .required({
    chapterAssignmentId: true,
    status: true,
    content: true,
  })
  .omit({
    id: true,
    createdAt: true,
  });

export const insertChapterAssignmentAssignedUserHistorySchema = createInsertSchema(
  chapter_assignment_assigned_user_history,
  {
    chapterAssignmentId: (schema) => schema.int(),
    assignedUserId: (schema) => schema.int(),
    role: z.enum(['drafter', 'peer_checker']),
  }
)
  .required({
    chapterAssignmentId: true,
    assignedUserId: true,
    role: true,
    status: true,
  })
  .omit({
    id: true,
    createdAt: true,
  });

export const insertChapterAssignmentStatusHistorySchema = createInsertSchema(
  chapter_assignment_status_history,
  {
    chapterAssignmentId: (schema) => schema.int(),
  }
)
  .required({
    chapterAssignmentId: true,
    status: true,
  })
  .omit({
    id: true,
    createdAt: true,
  });

export const insertUserChapterAssignmentEditorStateSchema = createInsertSchema(
  user_chapter_assignment_editor_state,
  {
    userId: (schema) => schema.int(),
    chapterAssignmentId: (schema) => schema.int(),
    resources: () => editorStateResourcesSchema,
  }
)
  .required({
    userId: true,
    chapterAssignmentId: true,
  })
  .omit({
    createdAt: true,
    updatedAt: true,
  });

export const insertProjectUsersSchema = createInsertSchema(project_users, {
  projectId: (schema) => schema.int(),
  userId: (schema) => schema.int(),
})
  .required({
    projectId: true,
    userId: true,
  })
  .omit({
    createdAt: true,
  });

export const insertUserSettingsSchema = createInsertSchema(user_settings, {
  userId: (schema) => schema.int(),
  settings: () => userSettingsSchema,
})
  .required({
    userId: true,
  })
  .omit({
    createdAt: true,
    updatedAt: true,
  });
export const insertPermissionsSchema = createInsertSchema(permissions, {
  name: (schema) => schema.min(1).max(100),
  description: (schema) => schema.max(255).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export const insertRolePermissionsSchema = createInsertSchema(role_permissions, {
  roleId: (schema) => schema.int(),
  permissionId: (schema) => schema.int(),
})
  .required({ roleId: true, permissionId: true })
  .omit({ updatedAt: true });

export const insertUserRolesSchema = createInsertSchema(user_roles, {
  userId: (schema) => schema.int(),
  orgId: (schema) => schema.int().optional(),
  projectId: (schema) => schema.int().optional(),
  roleId: (schema) => schema.int(),
})
  .required({ userId: true, roleId: true })
  .omit({ id: true, createdAt: true, updatedAt: true });

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

export const insertActiveChapterEditorsSchema = createInsertSchema(active_chapter_editors, {
  chapterAssignmentId: (schema) => schema.int(),
  userId: (schema) => schema.int(),
})
  .required({
    chapterAssignmentId: true,
    userId: true,
  })
  .omit({
    startedAt: true,
    lastHeartbeat: true,
  });
export const patchUsersSchema = insertUsersSchema.partial();
export const patchRolesSchema = insertRolesSchema.partial();
export const patchOrganizationsSchema = insertOrganizationsSchema.partial();
export const patchLanguagesSchema = insertLanguagesSchema.partial();
export const patchProjectsSchema = insertProjectsSchema.partial();
export const patchBiblesSchema = insertBiblesSchema.partial();
export const patchBibleBooksSchema = insertBibleBooksSchema.partial();
export const patchProjectUnitsSchema = insertProjectUnitsSchema.partial();
export const patchProjectUnitBibleBooksSchema = insertProjectUnitBibleBooksSchema.partial();
export const patchBibleTextsSchema = insertBibleTextsSchema.partial();
export const patchTranslatedVersesSchema = insertTranslatedVersesSchema.partial();
export const patchChapterAssignmentsSchema = insertChapterAssignmentsSchema.partial();
export const patchChapterAssignmentSnapshotsSchema =
  insertChapterAssignmentSnapshotsSchema.partial();
export const patchChapterAssignmentAssignedUserHistorySchema =
  insertChapterAssignmentAssignedUserHistorySchema.partial();
export const patchChapterAssignmentStatusHistorySchema =
  insertChapterAssignmentStatusHistorySchema.partial();
export const patchUserChapterAssignmentEditorStateSchema =
  insertUserChapterAssignmentEditorStateSchema.partial();
export const patchPermissionsSchema = insertPermissionsSchema.partial();
export const patchRolePermissionsSchema = insertRolePermissionsSchema.partial();
export const patchUserRolesSchema = insertUserRolesSchema.partial();
export const patchAiSuggestionsSchema = insertAiSuggestionsSchema.partial();
export const patchAiSuggestionUsageLogSchema = insertAiSuggestionUsageLogSchema.partial();

export const patchProjectsClientSchema = patchProjectsSchema.omit({
  organization: true,
  createdBy: true,
});

export const patchUsersClientSchema = patchUsersSchema;
