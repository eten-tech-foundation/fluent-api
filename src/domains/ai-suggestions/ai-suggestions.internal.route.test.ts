import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/server/server';

import * as aiSuggestionsService from './ai-suggestions.service';
import './ai-suggestions.internal.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/middlewares/service-auth', () => ({
  requireServiceAuth: vi.fn().mockImplementation(async (_c: any, next: any) => next()),
}));

vi.mock('@/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./ai-suggestions.service', () => ({
  getSuggestionContext: vi.fn(),
  saveAiSuggestions: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function postContext(body: unknown) {
  return server.request('/ai-suggestions/internal/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postResults(body: unknown) {
  return server.request('/ai-suggestions/internal/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const VALID_CONTEXT_BODY = {
  projectUnitId: 1,
  bibleId: 2,
  bookCode: 'GEN',
  chapterNumber: 1,
  verseStart: 1,
  verseEnd: 3,
};

const VALID_RESULTS_BODY = {
  items: [
    {
      bibleTextId: 10,
      projectUnitId: 1,
      suggestedText: 'translated text',
      modelInfo: 'gemini-2.0-flash',
    },
  ],
};

describe('ai-suggestions internal routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /ai-suggestions/internal/context ────────────────────────────────

  describe('pOST /ai-suggestions/internal/context', () => {
    it('returns 400 on invalid body (missing required fields)', async () => {
      const res = await postContext({ projectUnitId: 1 });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.message).toBe('Validation failed');
      expect(json.errors).toBeDefined();
    });

    it('returns 400 on malformed JSON payload', async () => {
      const res = await server.request('/ai-suggestions/internal/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.message).toBe('Invalid JSON payload');
    });

    it('returns 200 with context data on success', async () => {
      const mockData = {
        targetLanguageName: 'Hindi',
        contextVerses: [
          { verse_id: 'gen_1_1', source_text: 'In the beginning', target_text: 'शुरू में' },
        ],
        sourceVerses: [{ id: 1, verse_number: 1, text: 'In the beginning' }],
      };

      (aiSuggestionsService.getSuggestionContext as any).mockResolvedValue({
        ok: true,
        data: mockData,
      });

      const res = await postContext(VALID_CONTEXT_BODY);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.targetLanguageName).toBe('Hindi');
      expect(json.contextVerses).toHaveLength(1);
      expect(json.sourceVerses).toHaveLength(1);
    });

    it('returns error status when service returns an error', async () => {
      (aiSuggestionsService.getSuggestionContext as any).mockResolvedValue({
        ok: false,
        error: { message: 'Project unit not found', code: 'PROJECT_UNIT_NOT_FOUND' },
      });

      const res = await postContext(VALID_CONTEXT_BODY);
      expect(res.status).toBe(404);

      const json = await res.json();
      expect(json.message).toBe('Project unit not found');
    });
  });

  // ─── POST /ai-suggestions/internal/results ────────────────────────────────

  describe('pOST /ai-suggestions/internal/results', () => {
    it('returns 400 on invalid body (items must be array)', async () => {
      const res = await postResults({ items: 'not-an-array' });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.message).toBe('Validation failed');
    });

    it('returns 400 on malformed JSON payload', async () => {
      const res = await server.request('/ai-suggestions/internal/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.message).toBe('Invalid JSON payload');
    });

    it('returns 200 on success', async () => {
      (aiSuggestionsService.saveAiSuggestions as any).mockResolvedValue({
        ok: true,
        data: undefined,
      });

      const res = await postResults(VALID_RESULTS_BODY);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
    });

    it('returns error status when service returns an error', async () => {
      (aiSuggestionsService.saveAiSuggestions as any).mockResolvedValue({
        ok: false,
        error: { message: 'An unexpected error occurred', code: 'INTERNAL_ERROR' },
      });

      const res = await postResults(VALID_RESULTS_BODY);
      expect(res.status).toBe(500);

      const json = await res.json();
      expect(json.message).toBe('An unexpected error occurred');
    });
  });
});
