#!/usr/bin/env node
/**
 * Disposable PGlite exercise for PR #391 migration coordination.
 *
 * Not a production migrate path. Demonstrates:
 * 1) upgrade: minimal pre-range-audio schema → 0039_add_verse_audio_range_metadata
 * 2) repeated-run: tracked Drizzle skip (when <= last created_at) + raw SQL non-idempotency
 * 3) skip hazard: apply #391 first, then peer journal `when` values → peers silently skipped
 * 4) by-when SQL apply order (diagnostic only — NOT a whole-PR merge order)
 *
 * Migration rollback / down migrations are NOT part of this contract and are not exercised.
 * Live multi-connection PostgreSQL concurrency is NOT exercised here (single PGlite).
 *
 * Usage (from repo root, with node_modules available):
 *   node scripts/exercise-verse-audio-range-migration.mjs
 *   node scripts/exercise-verse-audio-range-migration.mjs /path/to/out.json
 */
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function splitSql(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function execStatements(db, sql, label) {
  const parts = splitSql(sql);
  for (const [i, stmt] of parts.entries()) {
    try {
      await db.exec(stmt);
    } catch (e) {
      throw new Error(`${label} stmt[${i}] failed: ${e.message}\n---\n${stmt}`);
    }
  }
}

/** Mirrors drizzle-orm/pg-core/dialect.js: apply only when last.created_at < folderMillis */
function shouldApply(lastCreatedAt, folderMillis) {
  return lastCreatedAt == null || Number(lastCreatedAt) < folderMillis;
}

async function baseSchema(db) {
  await db.exec(`
    CREATE TYPE "public"."verse_audio_conflict_status" AS ENUM('clean', 'conflict');
    CREATE TABLE "books" (id serial PRIMARY KEY);
    CREATE TABLE "verse_audio_recordings" (
      id serial PRIMARY KEY,
      project_unit_id integer NOT NULL,
      bible_text_id integer NOT NULL,
      conflict_status verse_audio_conflict_status NOT NULL DEFAULT 'clean'
    );
    CREATE TABLE "verse_audio_takes" (
      id serial PRIMARY KEY,
      recording_id integer NOT NULL
    );
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);
}

async function applyTracked(db, tag, when, sql) {
  const last = await db.query(
    `select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`
  );
  const lastCreatedAt = last.rows[0]?.created_at ?? null;
  if (!shouldApply(lastCreatedAt, when)) {
    return { applied: false, lastCreatedAt, when, tag };
  }
  await execStatements(db, sql, tag);
  const hash = createHash('sha256').update(sql).digest('hex');
  await db.query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`, [
    hash,
    when,
  ]);
  return { applied: true, lastCreatedAt, when, tag };
}

const journal = JSON.parse(
  readFileSync(resolve(root, 'src/db/migrations/meta/_journal.json'), 'utf8')
);
const entry391 = journal.entries.find((e) => e.tag === '0039_add_verse_audio_range_metadata');
if (!entry391) {
  throw new Error('journal missing 0039_add_verse_audio_range_metadata');
}
const when391 = entry391.when;
const sql391 = readFileSync(
  resolve(root, 'src/db/migrations/0039_add_verse_audio_range_metadata.sql'),
  'utf8'
);

/**
 * Peer journal `when` values from open PR heads at coordination time.
 * Peer SQL here is minimized for the when-skip demonstration only.
 */
const peers = [
  {
    pr: 372,
    tag: '0034_verse_audio_conflict_status_resolved',
    when: 1791286548662,
    sql: `ALTER TYPE "public"."verse_audio_conflict_status" ADD VALUE 'resolved';`,
  },
  {
    pr: 379,
    tag: '0034_add_books_timestamps',
    when: 1791491133531,
    sql: `ALTER TABLE "books" ADD COLUMN "created_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "updated_at" timestamp DEFAULT now();`,
  },
  {
    pr: 378,
    tag: '0034_add_dynamic_workflow_stages',
    when: 1791540661231,
    sql: `CREATE TABLE "project_workflow_stages" ("id" serial PRIMARY KEY NOT NULL);`,
  },
  {
    pr: 379,
    tag: '0035_bump_bibles_on_provider_resource_license',
    when: 1791600000000,
    sql: `SELECT 1;`,
  },
];

const results = {
  meta: {
    headHint: 'run from checkout; see git rev-parse HEAD',
    migrationTag: entry391.tag,
    when391,
    noteWholePrOrder:
      'Scenario 4 sorts individual SQL by journal when and INTERLEAVES #379 migrations with #378. That is diagnostic only. Practical merge order is whole-PR units (see PR #391 coordination reply).',
    notExercised: [
      'drizzle down / migration rollback SQL (none in contract)',
      'live multi-connection PostgreSQL concurrency',
      'shared/production databases',
    ],
  },
  upgrade: null,
  repeat: null,
  skipHazard391First: null,
  byWhenSqlDiagnostic: null,
};

// 1) Upgrade path
{
  const db = new PGlite();
  try {
    await baseSchema(db);
    await db.exec(
      `INSERT INTO verse_audio_recordings (project_unit_id, bible_text_id) VALUES (1, 10);`
    );
    await db.exec(`INSERT INTO verse_audio_takes (recording_id) VALUES (1);`);
    const r = await applyTracked(db, entry391.tag, when391, sql391);
    const cols = await db.query(`
      SELECT table_name, column_name, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name IN ('verse_audio_recordings','verse_audio_takes')
        AND column_name IN ('granularity','start_chapter','start_verse','end_chapter','end_verse')
      ORDER BY table_name, column_name`);
    const idx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'verse_audio_recordings'
        AND indexname = 'idx_verse_audio_recordings_project_unit'`);
    const seeded = await db.query(
      `SELECT granularity, start_chapter FROM verse_audio_recordings WHERE id = 1`
    );
    results.upgrade = {
      applied: r.applied,
      columnCount: cols.rows.length,
      columns: cols.rows,
      index: idx.rows,
      seededDefaults: seeded.rows[0],
      ok:
        r.applied &&
        cols.rows.length === 10 &&
        idx.rows.length === 1 &&
        seeded.rows[0].granularity === 'verse' &&
        seeded.rows[0].start_chapter === null,
    };
  } finally {
    await db.close();
  }
}

// 2) Repeated-run
{
  const db = new PGlite();
  try {
    await baseSchema(db);
    await applyTracked(db, entry391.tag, when391, sql391);
    let rawError = null;
    try {
      await execStatements(db, sql391, 'repeat');
    } catch (e) {
      rawError = e.message.split('\n')[0];
    }
    const tracked = await applyTracked(db, entry391.tag, when391, sql391);
    results.repeat = {
      behavior:
        'Tracked re-run skips (when not > last created_at). Raw SQL second apply is not idempotent.',
      rawSecondApplyErrors: Boolean(rawError),
      rawError,
      trackedSecondApply: tracked.applied,
      ok: Boolean(rawError) && tracked.applied === false,
    };
  } finally {
    await db.close();
  }
}

// 3) Skip hazard if #391 applied first on an env
{
  const db = new PGlite();
  try {
    await baseSchema(db);
    await applyTracked(db, entry391.tag, when391, sql391);
    const outcomes = [];
    for (const p of peers) {
      outcomes.push({ pr: p.pr, ...(await applyTracked(db, p.tag, p.when, p.sql)) });
    }
    results.skipHazard391First = {
      behavior:
        'After #391 when is recorded, unchanged peer migrations with earlier when are silently skipped. Renumbering #391 alone on main does not fix peers that later land still carrying those earlier timestamps.',
      outcomes,
      hazardConfirmed: outcomes.every((o) => o.applied === false),
      ok: outcomes.every((o) => o.applied === false),
    };
  } finally {
    await db.close();
  }
}

// 4) Diagnostic by-when SQL order (NOT whole-PR merge order)
{
  const db = new PGlite();
  try {
    await baseSchema(db);
    const ordered = [...peers].sort((a, b) => a.when - b.when);
    const outcomes = [];
    for (const p of ordered) {
      outcomes.push({ pr: p.pr, ...(await applyTracked(db, p.tag, p.when, p.sql)) });
    }
    outcomes.push({
      pr: 391,
      ...(await applyTracked(db, entry391.tag, when391, sql391)),
    });
    const cols = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='verse_audio_recordings' AND column_name='granularity'`
    );
    results.byWhenSqlDiagnostic = {
      warning: 'Interleaves #379 SQL with #378 — not a practical PR merge order.',
      outcomes: outcomes.map((o) => ({ pr: o.pr, tag: o.tag, applied: o.applied })),
      granularityPresent: cols.rows[0].n === 1,
      ok: outcomes.every((o) => o.applied) && cols.rows[0].n === 1,
    };
  } finally {
    await db.close();
  }
}

const allOk =
  results.upgrade.ok &&
  results.repeat.ok &&
  results.skipHazard391First.ok &&
  results.byWhenSqlDiagnostic.ok;

const outPath = resolve(
  process.argv[2] ?? resolve(__dirname, 'evidence/391-migration-exercise.json')
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ allOk, outPath, summary: results }, null, 2)}\n`);
process.exit(allOk ? 0 : 1);
