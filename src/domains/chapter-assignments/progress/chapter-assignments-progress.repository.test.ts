import type { SQL } from 'drizzle-orm';

import { describe, expect, it } from 'vitest';

import { VERSE_AUDIO_CONFLICT_STATUS } from '@/domains/verse-audio/verse-audio.types';

import * as progressRepo from './chapter-assignments-progress.repository';

function sqlText(fragment: SQL): string {
  const parts: string[] = [];
  const walk = (chunk: unknown): void => {
    if (chunk == null) {
      return;
    }
    if (typeof chunk === 'string') {
      parts.push(chunk);
      return;
    }
    if (typeof chunk !== 'object') {
      parts.push(String(chunk));
      return;
    }
    if ('value' in chunk && Array.isArray((chunk as { value: unknown[] }).value)) {
      for (const piece of (chunk as { value: unknown[] }).value) {
        walk(piece);
      }
      return;
    }
    if ('queryChunks' in chunk && Array.isArray((chunk as SQL).queryChunks)) {
      for (const piece of (chunk as SQL).queryChunks) {
        walk(piece);
      }
    }
  };
  walk(fragment);
  return parts.join('');
}

describe('chapter-assignments-progress.repository', () => {
  describe('hasConflictRollupSql', () => {
    it('correlates verse bible to the assignment bible so other-Bible conflicts are excluded', () => {
      const fragment = progressRepo.hasConflictRollupSql();
      const text = sqlText(fragment);

      expect(text).toContain('bt.bible_id');
      expect(text).toContain('bt.book_id');
      expect(text).toContain('bt.chapter_number');
      expect(text).toContain('var.project_unit_id');
      expect(text).toContain('var.conflict_status');
      expect(text).not.toMatch(/conflict_status\s*=\s*'conflict'/);
      expect(VERSE_AUDIO_CONFLICT_STATUS.CONFLICT).toBe('conflict');
    });

    it('filters strictly on conflict status so clean and resolved recordings are excluded', () => {
      const fragment = progressRepo.hasConflictRollupSql();
      const text = sqlText(fragment);

      expect(text).toMatch(/var\.conflict_status\s*=\s*conflict/);
      expect(text).not.toContain('resolved');
      expect(text).not.toContain('clean');
    });
  });
});
