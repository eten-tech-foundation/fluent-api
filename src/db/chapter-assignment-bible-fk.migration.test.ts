import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('chapter assignment bible FK migration', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE project_unit_bible_books (
        project_unit_id integer NOT NULL,
        book_id integer NOT NULL,
        bible_id integer NOT NULL
      );
      CREATE TABLE chapter_assignments (
        project_unit_id integer NOT NULL,
        book_id integer NOT NULL,
        bible_id integer NOT NULL
      );
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  async function migrate() {
    const sql = await readFile(
      new URL('./migrations/0040_chapter_assignment_bible_fk.sql', import.meta.url),
      'utf8'
    );
    await db.transaction(async (tx) => {
      // Drizzle executes migration statements sequentially in one transaction.
      for (const statement of sql.split('--> statement-breakpoint')) {
        await tx.exec(statement);
      }
    });
  }

  it.each([
    ['missing link', ''],
    ['different project unit', 'INSERT INTO project_unit_bible_books VALUES (9, 2, 3)'],
    ['different book', 'INSERT INTO project_unit_bible_books VALUES (1, 9, 3)'],
    ['different bible', 'INSERT INTO project_unit_bible_books VALUES (1, 2, 9)'],
    [
      'keys split across links',
      'INSERT INTO project_unit_bible_books VALUES (9, 2, 3), (1, 9, 3), (1, 2, 9)',
    ],
  ])('stops with reconciliation guidance for a %s', async (_description, links) => {
    await db.exec(`${links}; INSERT INTO chapter_assignments VALUES (1, 2, 3)`);

    await expect(migrate()).rejects.toMatchObject({
      message: expect.stringContaining(
        'chapter_assignments contains rows without a matching project_unit_bible_books (project_unit_id, book_id, bible_id) tuple'
      ),
      hint: 'Reconcile these rows before rerunning migration 0040_chapter_assignment_bible_fk.',
    });
    const assignments = await db.query('SELECT * FROM chapter_assignments');
    expect(assignments.rows).toEqual([{ project_unit_id: 1, book_id: 2, bible_id: 3 }]);
    const constraints = await db.query(`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'uq_project_unit_bible_books_unit_book_bible',
        'fk_chapter_assignments_bible_book_link'
      )
    `);
    expect(constraints.rows).toEqual([]);
  });

  it('accepts empty tables', async () => {
    await expect(migrate()).resolves.toBeUndefined();
  });

  it('accepts matching tuples and preserves FK enforcement and cascades', async () => {
    await db.exec(`
      INSERT INTO project_unit_bible_books VALUES (1, 2, 3);
      INSERT INTO chapter_assignments VALUES (1, 2, 3);
    `);
    await migrate();

    await expect(db.exec('INSERT INTO chapter_assignments VALUES (1, 2, 9)')).rejects.toMatchObject(
      { code: '23503' }
    );
    await db.exec('UPDATE project_unit_bible_books SET project_unit_id = 4');
    const assignments = await db.query('SELECT * FROM chapter_assignments');
    expect(assignments.rows).toEqual([{ project_unit_id: 4, book_id: 2, bible_id: 3 }]);
    await db.exec('DELETE FROM project_unit_bible_books');
    const remaining = await db.query('SELECT * FROM chapter_assignments');
    expect(remaining.rows).toEqual([]);
  });
});
