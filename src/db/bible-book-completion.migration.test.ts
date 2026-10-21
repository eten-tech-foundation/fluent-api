import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('leaves completion unknown when a pre-existing book has only some source verses', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE bible_books (bible_id integer, book_id integer);
      CREATE TABLE bible_texts (bible_id integer, book_id integer);
      INSERT INTO bible_books VALUES (1, 1), (1, 2);
      INSERT INTO bible_texts VALUES (1, 1);
    `);
    const migration = await readFile(
      new URL('./migrations/0031_add_bible_book_text_ingestion_completion.sql', import.meta.url),
      'utf8'
    );
    await db.exec(migration);
    const { rows } = await db.query(
      'SELECT book_id, text_ingested_at FROM bible_books ORDER BY book_id'
    );
    expect(rows).toEqual([
      { book_id: 1, text_ingested_at: null },
      { book_id: 2, text_ingested_at: null },
    ]);
  } finally {
    await db.close();
  }
}, 30000);
