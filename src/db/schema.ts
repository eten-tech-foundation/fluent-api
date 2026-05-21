/* eslint-disable max-lines */
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Json } from 'drizzle-zod';

import { z } from '@hono/zod-openapi';
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
  role: integer('role')
    .notNull()
    .references(() => roles.id),
  organization: integer('organization')
    .notNull()
    .references(() => organizations.id),
  status: userStatusEnum('status').notNull().default('invited'),
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
  })
  .nullable();

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
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index('idx_role_permissions_role').on(table.roleId),
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
export const selectPermissionsSchema = createSelectSchema(permissions);
export const selectRolePermissionsSchema = createSelectSchema(role_permissions);
export const selectActiveChapterEditorsSchema = createSelectSchema(active_chapter_editors);

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
    role: true,
    organization: true,
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
export const patchProjectUsersSchema = insertProjectUsersSchema.partial();
export const patchPermissionsSchema = insertPermissionsSchema.partial();
export const patchRolePermissionsSchema = insertRolePermissionsSchema.partial();

export const patchProjectsClientSchema = patchProjectsSchema.omit({
  organization: true,
  createdBy: true,
});

export const patchUsersClientSchema = patchUsersSchema.omit({
  organization: true,
});
