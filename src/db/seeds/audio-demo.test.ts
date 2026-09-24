import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db';

import { seedAudioDemo } from './audio-demo';
import { loadBsbJohn } from './bible-texts-bsb';

vi.mock('@/db', () => ({ db: { select: vi.fn(), transaction: vi.fn() } }));

describe('local audio fixture', () => {
  it.each(['dev', 'qa', 'prod'])('does no database work in %s', async (envName) => {
    await seedAudioDemo(envName, 'Shared');
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('fails clearly when local setup has no user', async () => {
    await expect(seedAudioDemo('local', 'Fluent Dev')).rejects.toThrow(
      'first configured local seed user'
    );
  });

  it('has the complete captured John corpus, with unchanged verse addresses and John 3 coverage', () => {
    const verses = loadBsbJohn();
    expect(verses).toHaveLength(878);
    expect(new Set(verses.map((row) => `${row.chapter}:${row.verse}`)).size).toBe(878);
    expect([...new Set(verses.map((row) => row.chapter))]).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1)
    );
    expect(verses.filter((row) => row.chapter === 3).map((row) => row.verse)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1)
    );
    expect(verses.every((row) => row.text.trim().length > 0)).toBe(true);
    expect(verses[0]?.text).toBe(
      'In the beginning was the Word, and the Word was with God, and the Word was God.'
    );
  });
});
