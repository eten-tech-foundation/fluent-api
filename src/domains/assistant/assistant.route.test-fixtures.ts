import type { Context, Next } from 'hono';

import { vi } from 'vitest';

import type { AppBindings, User } from '@/lib/types';

import { logger } from '@/lib/logger';
import { PERMISSIONS } from '@/lib/permissions';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import { resetInFlightBriefingsForTests, shutdownInFlightBriefings } from './assistant.cache';
import { BtServantClient } from './assistant.client';
import { loadAssistantConfig } from './assistant.config';
import { findProjectSourceLanguage, resolveCanonicalPassage } from './assistant.repository';
import {
  findCompletedBriefing,
  publishCompletedBriefing,
} from './cache/assistant-cache.repository';
import './assistant.route';

const authState = vi.hoisted(() => ({ user: undefined as User | undefined }));
vi.mock('@/middlewares/authenticate', () => ({
  authenticate: vi.fn(async (c: Context<AppBindings>, next: Next) => {
    if (authState.user) c.set('user', authState.user);
    await next();
  }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/projects/projects.service', () => ({ getProjectById: vi.fn() }));
vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(async () => false),
}));
vi.mock('./assistant.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assistant.config')>();
  return { ...actual, loadAssistantConfig: vi.fn() };
});
vi.mock('./assistant.repository', () => ({
  findProjectSourceLanguage: vi.fn(async () => 'eng'),
  resolveCanonicalPassage: vi.fn(),
}));
vi.mock('./cache/assistant-cache.repository', () => ({
  findCompletedBriefing: vi.fn(async () => null),
  publishCompletedBriefing: vi.fn(async () => true),
  requestExpiredBriefingCleanup: vi.fn(),
}));

export interface MockBtInstance {
  stream: ReturnType<typeof vi.fn>;
}

export type BtClientFactory = (
  options: ConstructorParameters<typeof BtServantClient>[0]
) => BtServantClient;

vi.mock('./assistant.client', () => ({
  BtServantClient: vi.fn(function (this: MockBtInstance) {
    this.stream = vi.fn(async function* () {
      yield { type: 'briefing_delta', delta: 'brief' };
      yield { type: 'briefing_complete', markdown: 'brief' };
    });
  }),
}));

export const user: User = {
  id: 17,
  email: 'assistant@example.test',
  status: 'verified' as const,
  lastActiveOrgId: 1,
  grants: [],
};
const project = { id: 7, organization: 1, name: 'Project' };
export const config = {
  baseUrl: 'https://bt.invalid',
  engineKey: 'fixture-only',
  org: 'fluent',
  languages: {
    en: {
      displayName: 'English',
      projectLanguageCodes: ['eng'],
      responseLanguageHint: 'en',
      guidanceSlug: 'default',
      defaultGrounding: 'en',
      grounding: { en: { resourceLanguage: 'en', instruction: 'Use English resources.' } },
    },
    hi: {
      displayName: 'हिन्दी',
      projectLanguageCodes: ['hin'],
      responseLanguageHint: 'hi',
      guidanceSlug: 'default',
      defaultGrounding: 'hi',
      grounding: {
        hi: { resourceLanguage: 'hi', instruction: 'Use Hindi resources.' },
        en: { resourceLanguage: 'en', instruction: 'Use English resources.' },
      },
    },
  },
  operationVersion: 'briefing-v1',
  profileVersion: 'fluent-profile-v1',
  resourcePolicyVersion: 'fluent-resource-policy-v1',
  cacheEpoch: '1',
  budgets: {
    connectMs: 10,
    idleMs: 20,
    totalMs: 30,
    maxInputBytes: 20_000,
    maxOutputBytes: 20_000,
    maxFrameBytes: 1_000_000,
  },
};

export function authenticate(canReadProject = true, projectId = 7) {
  user.grants = [
    {
      orgId: 1,
      projectId: canReadProject ? projectId : projectId + 1,
      permissions: new Set([PERMISSIONS.PROJECT_VIEW]),
    },
  ];
  authState.user = user;
}

export function post(
  body: Record<string, unknown>,
  options: { projectId?: number; signal?: AbortSignal } = {}
) {
  return server.request(`/projects/${options.projectId ?? 7}/assistant/briefing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

export const validBody = { bookCode: 'MAT', chapter: 4, activeVerse: 25, outputLanguage: 'en' };

export async function resetAssistantRouteTestFixture() {
  vi.clearAllMocks();
  authState.user = undefined;
  resetInFlightBriefingsForTests();
  vi.mocked(BtServantClient).mockImplementation(function (this: MockBtInstance) {
    this.stream = vi.fn(async function* () {
      yield { type: 'briefing_delta', delta: 'brief' };
      yield { type: 'briefing_complete', markdown: 'brief' };
    });
  } as unknown as BtClientFactory);
  vi.mocked(findCompletedBriefing).mockResolvedValue(null);
  vi.mocked(publishCompletedBriefing).mockResolvedValue(true);
  user.id = 17;
  config.budgets.maxInputBytes = 20_000;
  vi.mocked(loadAssistantConfig).mockReturnValue(config);
  vi.mocked(resolveCanonicalPassage).mockResolvedValue({
    sourceBible: 'Canonical Source',
    sourceLanguageCode: 'eng',
    verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'server source' }],
  });
  const projects = await import('@/domains/projects/projects.service');
  vi.mocked(projects.getProjectById).mockImplementation(
    async (id: number) =>
      ok({ ...project, id }) as Awaited<ReturnType<typeof projects.getProjectById>>
  );
}

export const assistantRouteMocks = {
  BtServantClient,
  findCompletedBriefing,
  findProjectSourceLanguage,
  loadAssistantConfig,
  logger,
  publishCompletedBriefing,
  resolveCanonicalPassage,
  server,
  shutdownInFlightBriefings,
};
