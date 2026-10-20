import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

import { resolveCanonicalPassage } from './assistant.repository';

const databaseState = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db', () => ({
  get db() {
    return databaseState.db;
  },
}));

let client: PGlite;
const input = { projectId: 7, bookCode: 'mat', chapter: 4, activeVerse: 25 };

beforeAll(async () => {
  client = new PGlite();
  databaseState.db = drizzle(client, { schema });
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
  });
}, 60000);

beforeEach(async () => {
  await client.exec(`
    TRUNCATE projects, bibles, languages, organizations, books, pericope_sets,
      pericope_verses, bible_texts CASCADE;
    INSERT INTO languages (id, lang_name, lang_code_iso_639_3)
      VALUES (1, 'English', 'eng'), (2, 'Target', 'hin');
    INSERT INTO organizations (id, name) VALUES (1, 'Test Organization');
    INSERT INTO pericope_sets (id, name) VALUES (3, 'Test Set');
    INSERT INTO bibles (id, language_id, name, abbreviation)
      VALUES (9, 1, 'Canonical Source', 'SRC');
    INSERT INTO books (id, code, eng_display_name) VALUES (40, 'MAT', 'Matthew');
    INSERT INTO projects (
      id, name, source_language, target_language, organization, source_bible_id, pericope_set_id
    ) VALUES (7, 'Project', 1, 2, 1, 9, 3);
    INSERT INTO pericope_verses (
      pericope_set_id, book_id, chapter_number, verse_number, pericope_number
    ) VALUES (3, 40, 4, 25, '12'), (3, 40, 5, 1, '12'), (3, 40, 5, 2, '12');
    INSERT INTO bible_texts (bible_id, book_id, chapter_number, verse_number, text)
    VALUES (9, 40, 4, 25, 'first'), (9, 40, 5, 1, 'second'), (9, 40, 5, 2, 'third');
  `);
});

afterAll(async () => client.close());

describe('canonical Assistant passage resolution', () => {
  it('returns the complete ordered cross-chapter pericope from real Drizzle queries', async () => {
    await expect(resolveCanonicalPassage(input)).resolves.toEqual({
      sourceBible: 'Canonical Source',
      sourceLanguageCode: 'eng',
      verses: [
        { bookCode: 'MAT', chapter: 4, verse: 25, text: 'first' },
        { bookCode: 'MAT', chapter: 5, verse: 1, text: 'second' },
        { bookCode: 'MAT', chapter: 5, verse: 2, text: 'third' },
      ],
    });
  });

  it('rejects canonical context without a project source-language code', async () => {
    await client.exec(`UPDATE languages SET lang_code_iso_639_3 = NULL WHERE id = 1`);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });

  it('fails before generation when any canonical source verse is missing', async () => {
    await client.exec(`DELETE FROM bible_texts WHERE chapter_number = 5 AND verse_number = 1`);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });

  it('uses only the exact source verse when the project has no pericope set', async () => {
    await client.exec(`UPDATE projects SET pericope_set_id = NULL WHERE id = 7`);
    await expect(resolveCanonicalPassage(input)).resolves.toMatchObject({
      verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'first' }],
    });
  });

  it('uses the exact source verse when no pericope covers the active verse', async () => {
    await client.exec(`DELETE FROM pericope_verses`);
    await expect(resolveCanonicalPassage(input)).resolves.toMatchObject({
      verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'first' }],
    });
  });

  it('rejects a missing exact fallback verse', async () => {
    await client.exec(`
      UPDATE projects SET pericope_set_id = NULL WHERE id = 7;
      DELETE FROM bible_texts WHERE chapter_number = 4 AND verse_number = 25;
    `);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });
});
