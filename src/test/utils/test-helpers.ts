import type { Context } from 'hono';
import type { Db, Job, QueueResult } from 'pg-boss';

import { PgBoss } from 'pg-boss';
import { vi } from 'vitest';

import { ErrorCode } from '@/lib/types';

/**
 * Creates a mock Hono Context with commonly used methods
 */
export function createMockContext(overrides: Partial<Context> = {}): Context {
  const mockContext = {
    json: vi.fn((data, status?) => ({ data, status }) as any),
    body: vi.fn((data, status?) => ({ data, status }) as any),
    text: vi.fn((text, status?) => ({ text, status }) as any),
    req: {
      json: vi.fn(),
      param: vi.fn(),
      query: vi.fn(),
      header: vi.fn(),
      valid: vi.fn(),
    },
    res: {},
    env: {},
    var: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    ...overrides,
  } as unknown as Context;

  return mockContext;
}

/**
 * Sample data for testing
 */
export const sampleUsers = {
  user1: {
    id: 1,
    username: 'testuser',
    email: 'test@example.com',
    firstName: 'John',
    lastName: 'Doe',
    grants: [],
    createdBy: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    authUserId: null,
    status: 'verified' as const,
    lastActiveOrgId: null,
  },
  user2: {
    id: 2,
    username: 'testuser2',
    email: 'test2@example.com',
    firstName: 'Jane',
    lastName: 'Smith',
    grants: [],
    createdBy: null,
    createdAt: new Date('2024-01-02T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    authUserId: null,
    status: 'invited' as const,
    lastActiveOrgId: null,
  },
  newUser: {
    username: 'newuser',
    email: 'newuser@example.com',
    firstName: 'John',
    lastName: 'Doe',
    grants: [],
    createdBy: null,
    status: 'invited' as const,
    lastActiveOrgId: null,
  },
  updateUser: {
    firstName: 'Jane',
    lastName: 'Smith',
  },
  updateUserWithEmail: {
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'updated@example.com',
  },
};

export const sampleLanguages = {
  english: {
    id: 1,
    description: 'English language',
    langName: 'English',
    langNameLocalized: 'English',
    langCodeBcp47: 'en',
    langCodeIso6393: 'eng',
    altLangNames: 'English',
    scriptDirection: 'ltr',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  spanish: {
    id: 3,
    description: 'Spanish language',
    langName: 'Spanish',
    langNameLocalized: 'Español',
    langCodeBcp47: 'es',
    langCodeIso6393: 'spa',
    altLangNames: 'Spanish',
    scriptDirection: 'ltr',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
};

export const sampleBibles = {
  kjv: {
    id: 1,
    name: 'King James Version',
    abbreviation: 'KJV',
    language: 1,
    description: 'English translation',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  rvr: {
    id: 2,
    name: 'Reina-Valera 1960',
    abbreviation: 'RVR60',
    language: 3,
    description: 'Spanish translation',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
};

export const sampleProjects = {
  project1: {
    id: 1,
    name: 'Test Project',
    sourceLanguage: 1,
    targetLanguage: 3,
    isActive: true,
    createdBy: 1,
    organization: 1,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    metadata: { priority: 'high', category: 'marketing' },
  },
  newProject: {
    name: 'New Test Project',
    sourceLanguage: 1,
    targetLanguage: 3,
    isActive: true,
    createdBy: 1,
    organization: 1,
    metadata: { priority: 'high', category: 'product' },
    projectUnitStatus: 'not_started' as const,
    bibleId: 1,
    bookId: [1, 2],
  },
  updateProject: {
    name: 'Updated Project Name',
    metadata: { priority: 'medium', category: 'updated' },
  },
  updateProjectWithUnits: {
    name: 'Updated Project Name',
    metadata: { priority: 'medium', category: 'updated' },
    bibleId: 2,
    bookId: [3, 4, 5],
  },
  projectWithLanguageNames1: {
    id: 1,
    name: 'Test Project',
    organization: 1,
    isActive: true,
    createdBy: 1,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    metadata: { priority: 'high', category: 'marketing' },
    sourceBibleId: 1,
    sourceLanguageName: 'English',
    targetLanguageName: 'Spanish',
    sourceName: 'King James Version',
    milestoneCount: 1,
  },
};

export const sampleProjectUnits = {
  unit1: {
    id: 1,
    projectId: 1,
    name: 'Test Project',
    type: 'text' as const,
    status: 'not_started' as const,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  unit2: {
    id: 2,
    projectId: 1,
    name: 'Second milestone',
    type: 'text' as const,
    status: 'in_progress' as const,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  newUnit: {
    projectId: 1,
    name: 'New milestone',
    type: 'text' as const,
    status: 'not_started' as const,
  },
};

export const sampleProjectUnitBibleBooks = {
  book1: {
    id: 1,
    projectUnitId: 1,
    bibleId: 1,
    bookId: 1,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  book2: {
    id: 2,
    projectUnitId: 1,
    bibleId: 1,
    bookId: 2,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  newBook: {
    projectUnitId: 1,
    bibleId: 1,
    bookId: 3,
  },
};

export const sampleChapterAssignments = [
  {
    id: 1,
    projectUnitId: 1,
    bibleId: 1,
    bookId: 1,
    chapterNumber: 1,
    assignedUserId: 1,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  {
    id: 2,
    projectUnitId: 1,
    bibleId: 1,
    bookId: 1,
    chapterNumber: 2,
    assignedUserId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
];

export const sampleChapterInfo = [
  {
    bibleId: 1,
    bookId: 1,
    chapterNumber: 1,
    verseCount: 31,
  },
  {
    bibleId: 1,
    bookId: 1,
    chapterNumber: 2,
    verseCount: 25,
  },
];

/**
 * Utility to reset all mocks before each test
 */
export function resetAllMocks() {
  vi.clearAllMocks();
}

/**
 * Helper to create result objects for testing
 */
export function createResult<T>(data: T, success: boolean = true) {
  return success
    ? { ok: true, data }
    : {
        ok: false,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: typeof data === 'string' ? data : 'Error occurred',
        },
      };
}

/** A complete pg-boss queue fixture with overridable settings. */
export function queueResult(name: string, overrides: Partial<QueueResult> = {}): QueueResult {
  return {
    name,
    policy: 'standard',
    deferredCount: 0,
    queuedCount: 0,
    activeCount: 0,
    totalCount: 0,
    table: 'job',
    createdOn: new Date('2026-01-01T00:00:00Z'),
    updatedOn: new Date('2026-01-01T00:00:00Z'),
    singletonsActive: null,
    ...overrides,
  };
}

/** A complete job fixture for invoking a registered pg-boss handler. */
export function jobResult<T>(data: T, overrides: Partial<Job<T>> = {}): Job<T> {
  return { id: 'job-1', name: 'test-queue', data, expireInSeconds: 900, ...overrides };
}

/**
 * Uses an unstarted instance so spies keep pg-boss's real method contracts.
 * The stub database prevents these unit-test queues from opening a connection.
 */
export function fakeBoss() {
  const executeSql = vi.fn<Db['executeSql']>().mockImplementation(async (query) => {
    if (query.includes('pgboss.version')) return { rows: [{ version: 26 }] };
    return {
      rows: [{ depth: 0, queuedCount: 0, activeCount: 0, deferredCount: 0, oldestCreatedOn: null }],
    };
  });
  const boss = new PgBoss({ db: { executeSql } });
  const getQueue = vi.spyOn(boss, 'getQueue').mockResolvedValue(null);
  const createQueue = vi.spyOn(boss, 'createQueue').mockResolvedValue(undefined);
  const updateQueue = vi.spyOn(boss, 'updateQueue').mockResolvedValue(undefined);
  const deleteQueue = vi.spyOn(boss, 'deleteQueue').mockResolvedValue(undefined);
  const getQueues = vi.spyOn(boss, 'getQueues').mockResolvedValue([]);
  const getDb = vi.spyOn(boss, 'getDb').mockReturnValue({ executeSql });
  const work = vi.spyOn(boss, 'work').mockResolvedValue('test-worker');
  return {
    boss,
    getQueue,
    createQueue,
    updateQueue,
    deleteQueue,
    getQueues,
    getDb,
    executeSql,
    work,
  };
}
