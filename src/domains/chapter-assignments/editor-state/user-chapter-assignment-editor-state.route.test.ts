import type { Context, Next } from 'hono';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/server/server';

import * as editorStateService from './user-chapter-assignment-editor-state.service';
import './user-chapter-assignment-editor-state.route';

vi.mock('@/middlewares/authenticate', () => ({
  authenticate: vi.fn(async (c, next) => {
    c.set('user', { id: 17, email: 'editor@example.test', status: 'verified', grants: [] });
    await next();
  }),
}));

vi.mock('@/domains/chapter-assignments/chapter-assignment-auth.middleware', () => ({
  requireChapterAssignmentAccess: vi.fn(() => async (_c: Context, next: Next) => next()),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./user-chapter-assignment-editor-state.service', () => ({
  upsertEditorState: vi.fn(async (input) => ({ ok: true, data: input.resources })),
  getEditorState: vi.fn(),
}));

const resources = {
  activeResource: 'dbl',
  bookCode: 'MAT',
  chapterNumber: 4,
  verseNumber: 25,
  languageCode: 'eng',
  tabStatus: true,
};

function saveEditorState(activeLeftTab: 'resources' | 'checks' | 'assistant') {
  return server.request('/chapter-assignments/9/editor-state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resources: { ...resources, activeLeftTab } }),
  });
}

describe('PUT /chapter-assignments/:chapterAssignmentId/editor-state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['resources', 'checks', 'assistant'] as const)(
    'accepts activeLeftTab "%s" through the route request schema',
    async (activeLeftTab) => {
      const response = await saveEditorState(activeLeftTab);

      expect(response.status).toBe(200);
      expect(editorStateService.upsertEditorState).toHaveBeenCalledWith({
        userId: 17,
        chapterAssignmentId: 9,
        resources: { ...resources, activeLeftTab },
      });
    }
  );
});
