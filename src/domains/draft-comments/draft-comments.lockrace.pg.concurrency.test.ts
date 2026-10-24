/**
 * Real PostgreSQL multi-backend lock-order / SELECT→INSERT race proofs.
 *
 * Gated solely by DRAFT_COMMENTS_LOCKRACE_DATABASE_URL (disposable container URI).
 * Does NOT read DATABASE_URL / .env / live platform DBs. Distinct from PGlite suites.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const uri = process.env.DRAFT_COMMENTS_LOCKRACE_DATABASE_URL?.trim();
const describeLockrace = uri ? describe : describe.skip;

const PUBLIC_6_1 = '6_1';
const PUBLIC_7_1 = '7_1';
const ADV = (publicId: string) => `1/40/1/${publicId}`;

async function waitUntilWaiting(
  observer: postgres.Sql,
  appName: string,
  waitEvent: string,
  attempts = 80
) {
  for (let i = 0; i < attempts; i++) {
    const rows = await observer`
      SELECT wait_event_type, wait_event, state
      FROM pg_stat_activity
      WHERE application_name = ${appName}
        AND pid <> pg_backend_pid()
        AND state <> 'idle'
        AND wait_event = ${waitEvent}
    `;
    if (rows.length > 0) return rows[0];
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describeLockrace('draft-comments lockrace (real PostgreSQL multi-backend)', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(uri!, { max: 1, connection: { application_name: 'lockrace_admin' } });
    // Schema is applied by the disposable harness; verify essentials exist.
    const tables = await admin`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('pericope_verses', 'chapter_comments')
    `;
    expect(tables[0]?.n).toBe(2);
  }, 30_000);

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  it('reproduces OLD order advisory→row deadlock with AFTER trigger (row→advisory)', async () => {
    await admin`DELETE FROM chapter_comments`;
    await admin`DELETE FROM pericope_verses`;
    await admin`
      INSERT INTO pericope_verses
        (pericope_set_id, book_id, chapter_number, verse_number, section, pericope_number, pericope_title)
      VALUES (1, 40, 1, 1, 6, '1', 'Sec6')
    `;

    const audio = postgres(uri!, { max: 1, connection: { application_name: 'audio_old' } });
    const mut = postgres(uri!, { max: 1, connection: { application_name: 'mut_old' } });
    await audio.unsafe(`SELECT set_config('deadlock_timeout', '200ms', false)`);
    await mut.unsafe(`SELECT set_config('deadlock_timeout', '200ms', false)`);
    await audio.unsafe('BEGIN');
    await mut.unsafe('BEGIN');

    await audio`SELECT pg_advisory_xact_lock(87201458, hashtext(${ADV(PUBLIC_6_1)}))`;

    const mutPromise = mut`
      DELETE FROM pericope_verses WHERE pericope_set_id = 1 AND book_id = 40 AND chapter_number = 1
    `.then(
      () => ({ ok: true as const }),
      (e: { code?: string; message?: string }) => ({
        ok: false as const,
        code: e.code,
        message: String(e.message),
      })
    );

    const waiting = await waitUntilWaiting(audio, 'mut_old', 'advisory');
    expect(waiting).not.toBeNull();

    let audioCode: string | undefined;
    try {
      await audio`
        SELECT id FROM pericope_verses
        WHERE pericope_set_id = 1 AND book_id = 40 AND chapter_number = 1
          AND section IS NOT NULL
          AND (section::text || '_' || pericope_number) = ${PUBLIC_6_1}
        FOR UPDATE
      `;
    } catch (e) {
      audioCode = (e as { code?: string }).code;
    }
    const mutResult = await mutPromise;
    await audio.unsafe('ROLLBACK').catch(() => {});
    await mut.unsafe('ROLLBACK').catch(() => {});
    await audio.end({ timeout: 5 });
    await mut.end({ timeout: 5 });

    const mutCode = mutResult.ok ? undefined : mutResult.code;
    expect(audioCode === '40P01' || mutCode === '40P01').toBe(true);
  }, 15_000);

  it('uses fixed order row→advisory: no deadlock; mutation after locks cannot leave stale connected', async () => {
    await admin`DELETE FROM chapter_comments`;
    await admin`DELETE FROM pericope_verses`;
    await admin`
      INSERT INTO pericope_verses
        (pericope_set_id, book_id, chapter_number, verse_number, section, pericope_number, pericope_title)
      VALUES (1, 40, 1, 1, 6, '1', 'Sec6')
    `;

    const audio = postgres(uri!, { max: 1, connection: { application_name: 'audio_fixed' } });
    const mut = postgres(uri!, { max: 1, connection: { application_name: 'mut_fixed' } });
    await audio.unsafe(`SELECT set_config('deadlock_timeout', '200ms', false)`);
    await mut.unsafe(`SELECT set_config('deadlock_timeout', '200ms', false)`);
    await audio.unsafe(`SELECT set_config('lock_timeout', '5s', false)`);
    await mut.unsafe(`SELECT set_config('lock_timeout', '5s', false)`);

    await audio.unsafe('BEGIN');
    // FIXED audio order: FOR UPDATE membership rows, then advisory (same as AFTER trigger).
    await audio`
      SELECT id FROM pericope_verses
      WHERE pericope_set_id = 1 AND book_id = 40 AND chapter_number = 1
        AND section IS NOT NULL
        AND (section::text || '_' || pericope_number) = ${PUBLIC_6_1}
      FOR UPDATE
    `;
    await audio`SELECT pg_advisory_xact_lock(87201458, hashtext(${ADV(PUBLIC_6_1)}))`;

    // Mutation starts while audio holds row+advisory — must block on row, not deadlock.
    const mutPromise = mut.unsafe('BEGIN').then(async () => {
      try {
        await mut`
          DELETE FROM pericope_verses WHERE pericope_set_id = 1 AND book_id = 40 AND chapter_number = 1
        `;
        await mut.unsafe('COMMIT');
        return { ok: true as const };
      } catch (e) {
        await mut.unsafe('ROLLBACK').catch(() => {});
        return {
          ok: false as const,
          code: (e as { code?: string }).code,
          message: String((e as Error).message),
        };
      }
    });

    const waiting = await waitUntilWaiting(audio, 'mut_fixed', 'transactionid');
    const waitingAlt = waiting ?? (await waitUntilWaiting(audio, 'mut_fixed', 'tuple'));
    expect(waitingAlt).not.toBeNull();

    // Insert connected comment under locks (post-revalidation INSERT).
    const inserted = await audio`
      INSERT INTO chapter_comments (
        project_id, chapter_assignment_id, author_user_id, body_kind, audio_storage_key,
        anchor_kind, anchor_bible_id, anchor_book_id, anchor_chapter_number,
        anchor_pericope_set_id, anchor_pericope_number, connection_state
      ) VALUES (
        1, 1, 1, 'audio', 'comments/1/00000000-0000-0000-0000-0000000000aa/hash',
        'pericope', 1, 40, 1, 1, ${PUBLIC_6_1}, 'connected'
      ) RETURNING id, connection_state
    `;
    expect(inserted[0]?.connection_state).toBe('connected');
    await audio.unsafe('COMMIT');

    const mutResult = await mutPromise;
    expect(mutResult.ok).toBe(true);
    expect(mutResult.ok ? undefined : mutResult.code).not.toBe('40P01');

    const finalState = await admin`
      SELECT connection_state FROM chapter_comments WHERE id = ${inserted[0]!.id}
    `;
    // Trigger ran after audio committed → must invalidate; no stale connected.
    expect(finalState[0]?.connection_state).toBe('unconnected');

    await audio.end({ timeout: 5 });
    await mut.end({ timeout: 5 });
  }, 20_000);

  it('covers section 6_1→7_1 UPDATE under fixed order: no deadlock; OLD and NEW identities invalidated', async () => {
    await admin`DELETE FROM chapter_comments`;
    await admin`DELETE FROM pericope_verses`;
    await admin`
      INSERT INTO pericope_verses
        (pericope_set_id, book_id, chapter_number, verse_number, section, pericope_number, pericope_title)
      VALUES (1, 40, 1, 1, 6, '1', 'Sec6')
    `;
    await admin`
      INSERT INTO chapter_comments (
        project_id, chapter_assignment_id, author_user_id, body_kind, audio_storage_key,
        anchor_kind, anchor_bible_id, anchor_book_id, anchor_chapter_number,
        anchor_pericope_set_id, anchor_pericope_number, connection_state
      ) VALUES
        (1, 1, 1, 'audio', 'comments/1/a/h', 'pericope', 1, 40, 1, 1, ${PUBLIC_6_1}, 'connected'),
        (1, 1, 1, 'audio', 'comments/1/b/h', 'pericope', 1, 40, 1, 1, ${PUBLIC_7_1}, 'connected')
    `;

    const audio = postgres(uri!, { max: 1, connection: { application_name: 'audio_sec' } });
    const mut = postgres(uri!, { max: 1, connection: { application_name: 'mut_sec' } });
    await audio.unsafe(`SELECT set_config('deadlock_timeout', '200ms', false)`);
    await mut.unsafe(`SELECT set_config('deadlock_timeout', '200ms', false)`);
    await audio.unsafe(`SELECT set_config('lock_timeout', '5s', false)`);
    await mut.unsafe(`SELECT set_config('lock_timeout', '5s', false)`);

    await audio.unsafe('BEGIN');
    await audio`
      SELECT id FROM pericope_verses
      WHERE pericope_set_id = 1 AND book_id = 40 AND chapter_number = 1
        AND section IS NOT NULL
        AND (section::text || '_' || pericope_number) = ${PUBLIC_6_1}
      FOR UPDATE
    `;
    await audio`SELECT pg_advisory_xact_lock(87201458, hashtext(${ADV(PUBLIC_6_1)}))`;

    const mutPromise = mut.unsafe('BEGIN').then(async () => {
      try {
        await mut`UPDATE pericope_verses SET section = 7 WHERE section = 6 AND pericope_number = '1'`;
        await mut.unsafe('COMMIT');
        return { ok: true as const };
      } catch (e) {
        await mut.unsafe('ROLLBACK').catch(() => {});
        return { ok: false as const, code: (e as { code?: string }).code };
      }
    });

    const waiting = await waitUntilWaiting(audio, 'mut_sec', 'transactionid');
    expect(waiting ?? (await waitUntilWaiting(audio, 'mut_sec', 'tuple'))).not.toBeNull();

    await audio`
      INSERT INTO chapter_comments (
        project_id, chapter_assignment_id, author_user_id, body_kind, audio_storage_key,
        anchor_kind, anchor_bible_id, anchor_book_id, anchor_chapter_number,
        anchor_pericope_set_id, anchor_pericope_number, connection_state
      ) VALUES (
        1, 1, 1, 'audio', 'comments/1/c/h', 'pericope', 1, 40, 1, 1, ${PUBLIC_6_1}, 'connected'
      )
    `;
    await audio.unsafe('COMMIT');
    const mutResult = await mutPromise;
    expect(mutResult.ok).toBe(true);

    const states = await admin`
      SELECT anchor_pericope_number, connection_state
      FROM chapter_comments
      ORDER BY id
    `;
    // Pre-existing 6_1 + newly inserted 6_1 → unconnected via OLD identity path;
    // pre-seeded 7_1 → unconnected via NEW identity path after section flip.
    expect(states.every((r) => r.connection_state === 'unconnected')).toBe(true);
    expect(states.map((r) => r.anchor_pericope_number).sort()).toEqual(
      [PUBLIC_6_1, PUBLIC_6_1, PUBLIC_7_1].sort()
    );

    await audio.end({ timeout: 5 });
    await mut.end({ timeout: 5 });
  }, 20_000);

  it('empty membership: advisory after FOR UPDATE blocks insert-phantom INSERT until reject commits', async () => {
    await admin`DELETE FROM chapter_comments`;
    await admin`DELETE FROM pericope_verses`;

    const audio = postgres(uri!, { max: 1, connection: { application_name: 'audio_phantom' } });
    const ins = postgres(uri!, { max: 1, connection: { application_name: 'ins_phantom' } });
    await audio.unsafe(`SELECT set_config('deadlock_timeout', '200ms', false)`);
    await ins.unsafe(`SELECT set_config('deadlock_timeout', '200ms', false)`);
    await audio.unsafe(`SELECT set_config('lock_timeout', '5s', false)`);
    await ins.unsafe(`SELECT set_config('lock_timeout', '5s', false)`);

    await audio.unsafe('BEGIN');
    const locked = await audio`
      SELECT id FROM pericope_verses
      WHERE pericope_set_id = 1 AND book_id = 40 AND chapter_number = 1
        AND section IS NOT NULL
        AND (section::text || '_' || pericope_number) = ${PUBLIC_6_1}
      FOR UPDATE
    `;
    expect(locked).toHaveLength(0);
    await audio`SELECT pg_advisory_xact_lock(87201458, hashtext(${ADV(PUBLIC_6_1)}))`;

    // Concurrent INSERT of membership (would create phantom) must wait on advisory in AFTER trigger.
    const insPromise = ins.unsafe('BEGIN').then(async () => {
      try {
        await ins`
          INSERT INTO pericope_verses
            (pericope_set_id, book_id, chapter_number, verse_number, section, pericope_number, pericope_title)
          VALUES (1, 40, 1, 1, 6, '1', 'Sec6')
        `;
        await ins.unsafe('COMMIT');
        return { ok: true as const };
      } catch (e) {
        await ins.unsafe('ROLLBACK').catch(() => {});
        return { ok: false as const, code: (e as { code?: string }).code };
      }
    });

    const waiting = await waitUntilWaiting(audio, 'ins_phantom', 'advisory');
    expect(waiting).not.toBeNull();

    // Audio rejects create (no membership) and releases advisory — no comment inserted.
    await audio.unsafe('ROLLBACK');
    const insResult = await insPromise;
    expect(insResult.ok).toBe(true);
    expect(insResult.ok ? undefined : insResult.code).not.toBe('40P01');

    const comments = await admin`SELECT count(*)::int AS n FROM chapter_comments`;
    expect(comments[0]?.n).toBe(0);
    const verses = await admin`SELECT count(*)::int AS n FROM pericope_verses`;
    expect(verses[0]?.n).toBe(1);

    await audio.end({ timeout: 5 });
    await ins.end({ timeout: 5 });
  }, 20_000);
});
