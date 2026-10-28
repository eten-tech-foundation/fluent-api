import { and, inArray, isNotNull } from 'drizzle-orm';

import { db } from '@/db';
import { bible_books, bibles } from '@/db/schema';
import env from '@/env';
import { ensureWorkerQueue } from '@/lib/dead-letter-queues';
import { initializeQueue, QUEUE_NAMES, stopQueue } from '@/lib/queue';

import type { DemoSpec } from './types';

/**
 * A desired `dbl-ingest-text` job expressed in spec keys — resolved to ids by
 * the engine. One job per milestone carries every book lacking `bible_texts`
 * rows, matching the batched `DblIngestTextJob.bookCodes` shape.
 */
interface IngestJobPlan {
  projectKey: string;
  milestoneKey: string;
  bibleAbbrev: string;
  bookCodes: string[];
}

/** The slice of the seed context `seedIngestJobs` resolves spec keys against. */
interface IngestCtx {
  spec: DemoSpec;
  bibles: Map<string, number>; // abbreviation → bibles.id
  books: Map<string, number>; // code → books.id
  milestones: Map<string, number>; // `${projectKey}/${milestoneKey}` → project_units.id
}

/**
 * Plans DBL text-ingest jobs for spec milestone books that have no text yet.
 * The engine passes `hasText` built from the `bible_books.text_ingested_at`
 * marker, so a re-run of the seed on an already-ingested database plans
 * nothing. Milestones whose bible has no `externalId` are dropped here — the
 * worker hard-fails those (retry spam to dead-letter), so enqueueing them is
 * worse than skipping.
 */
export function planIngestJobs(
  spec: DemoSpec,
  hasText: (bibleAbbrev: string, bookCode: string) => boolean,
  externalIds: ReadonlyMap<string, string | null>
): IngestJobPlan[] {
  const plan: IngestJobPlan[] = [];
  for (const project of spec.projects) {
    for (const milestone of project.milestones) {
      if (!externalIds.get(project.sourceBible)) continue;
      const bookCodes = milestone.books
        .map((b) => b.code)
        .filter((code) => !hasText(project.sourceBible, code));
      if (bookCodes.length) {
        plan.push({
          projectKey: project.key,
          milestoneKey: milestone.key,
          bibleAbbrev: project.sourceBible,
          bookCodes,
        });
      }
    }
  }
  return plan;
}

/**
 * Reproduces the enqueue side of milestones.service's book-link flow, which
 * the engine bypasses by writing `project_unit_bible_books` directly. The
 * worker does the real DBL fetch + writes; we only plan jobs for books not
 * yet ingested and degrade to warnings when ingestion can't work — an
 * unconfigured DBL key, a missing externalId, or an unreachable queue never
 * fails the seed.
 */
export async function seedIngestJobs(ctx: IngestCtx): Promise<void> {
  if (!env.DBL_API_KEY) {
    console.warn('  ingest jobs: skipped — DBL_API_KEY is not set');
    return;
  }

  const abbrevs = [...new Set(ctx.spec.projects.map((p) => p.sourceBible))];
  if (!abbrevs.length) return;

  // Resolve externalIds through ctx.bibles — the engine's adopted rows. A bare
  // abbreviation lookup can hit a different upstream row after a catalogue
  // sync (QA's 'BSB' is 317e…; the adopted 'BSB-bba9f4' holds our bba9f…).
  const bibleIds = abbrevs.map((a) => ctx.bibles.get(a)!);
  const bibleRows = await db
    .select({ id: bibles.id, externalId: bibles.externalId })
    .from(bibles)
    .where(inArray(bibles.id, bibleIds));
  const externalIdById = new Map(bibleRows.map((r) => [r.id, r.externalId]));
  const externalIds = new Map(
    abbrevs.map((a) => [a, externalIdById.get(ctx.bibles.get(a)!) ?? null])
  );
  const noExternalId = abbrevs.filter((a) => !externalIds.get(a));
  if (noExternalId.length) {
    console.warn(`  ingest jobs: skipping ${noExternalId.join(', ')} — no bibles.externalId`);
  }

  // bible_books.textIngestedAt is the codebase's ingest-complete marker:
  // NULL covers never-ingested *and* partially-ingested books (a worker that
  // died mid-book leaves rows but no stamp — those must re-plan), while the
  // stamp guarantees re-runs of the seed plan nothing.
  const ingested = await db
    .select({ bibleId: bible_books.bibleId, bookId: bible_books.bookId })
    .from(bible_books)
    .where(and(inArray(bible_books.bibleId, bibleIds), isNotNull(bible_books.textIngestedAt)));
  const ingestedPairs = new Set(ingested.map((t) => `${t.bibleId}:${t.bookId}`));
  const hasText = (abbrev: string, code: string) =>
    ingestedPairs.has(`${ctx.bibles.get(abbrev)}:${ctx.books.get(code)!}`);

  const jobs = planIngestJobs(ctx.spec, hasText, externalIds);
  if (!jobs.length) {
    console.log('  ingest jobs: none — all milestone books already ingested');
    return;
  }

  const boss = await initializeQueue().catch(async (e: Error) => {
    console.warn(`  ingest jobs: queue unavailable, skipping (${e.message})`);
    // initializeQueue caches `boss` before start() finishes — clear a
    // possibly-poisoned singleton so the seed process can exit cleanly.
    await stopQueue().catch(() => {});
    return null;
  });
  if (!boss) return;

  try {
    // Queues exist only after some worker creates them — a seed that runs
    // before first worker boot must converge the queue itself or every send
    // fails with "Queue ... does not exist" and the jobs are lost.
    try {
      await ensureWorkerQueue(boss, QUEUE_NAMES.DBL_INGEST_TEXT);
    } catch (e) {
      console.warn(`  ingest jobs: queue setup failed (${(e as Error).message}) — skipping`);
      return;
    }
    for (const job of jobs) {
      const bibleId = ctx.bibles.get(job.bibleAbbrev)!;
      const projectUnitId = ctx.milestones.get(`${job.projectKey}/${job.milestoneKey}`)!;
      try {
        const jobId = await boss.send(
          QUEUE_NAMES.DBL_INGEST_TEXT,
          { bibleId, bookCodes: job.bookCodes, projectUnitId },
          // singletonSeconds backs the key — without it re-runs while jobs
          // are still queued would send duplicates (verified: pg-boss only
          // dedupes singletonKey within the seconds window or under an
          // 'exclusive' queue policy this queue doesn't carry).
          { singletonKey: `seed-ingest:${bibleId}:${projectUnitId}`, singletonSeconds: 3600 }
        );
        console.log(
          jobId
            ? `  ingest job ${job.bibleAbbrev} ${job.bookCodes.join(',')} → unit ${projectUnitId}`
            : `  ingest job ${job.milestoneKey} already queued (deduped)`
        );
      } catch (e) {
        console.warn(
          `  ingest job ${job.milestoneKey} failed to enqueue (${(e as Error).message})`
        );
      }
    }
  } finally {
    await stopQueue();
  }
}
