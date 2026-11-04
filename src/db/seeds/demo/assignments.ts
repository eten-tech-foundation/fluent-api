import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  chapter_assignment_assigned_user_history,
  chapter_assignment_status_history,
  chapter_assignments,
} from '@/db/schema';

import type { DemoCtx } from './context';

// ─── Stage 8: chapter assignments (+ status history) ────────────────────────
// Direct inserts: the app's createChapterAssignmentForProjectUnit discovers
// chapters from bible_texts, which demo bibles may not have — the spec's
// chapter list is authoritative here.

export async function seedSpecChapterAssignments(ctx: DemoCtx) {
  for (const project of ctx.spec.projects) {
    const bibleId = ctx.bibles.get(project.sourceBible)!;
    for (const milestone of project.milestones) {
      const unitId = ctx.milestones.get(`${project.key}/${milestone.key}`)!;
      for (const book of milestone.books) {
        const bookId = ctx.books.get(book.code)!;
        const existing = await db
          .select()
          .from(chapter_assignments)
          .where(
            and(
              eq(chapter_assignments.projectUnitId, unitId),
              eq(chapter_assignments.bibleId, bibleId),
              eq(chapter_assignments.bookId, bookId)
            )
          );
        const byChapter = new Map(existing.map((a) => [a.chapterNumber, a]));

        for (const ch of book.chapters) {
          const assignedUserId = ch.assignedTo ? ctx.users.get(ch.assignedTo) : null;
          if (ch.assignedTo && !assignedUserId) {
            throw new Error(
              `Chapter ${book.code} ${ch.number} assigned to unknown user "${ch.assignedTo}"`
            );
          }
          const peerCheckerId = ch.peerChecker ? ctx.users.get(ch.peerChecker) : null;
          if (ch.peerChecker && !peerCheckerId) {
            throw new Error(
              `Chapter ${book.code} ${ch.number} peer-checked by unknown user "${ch.peerChecker}"`
            );
          }

          const row = byChapter.get(ch.number);
          if (!row) {
            const [inserted] = await db
              .insert(chapter_assignments)
              .values({
                projectUnitId: unitId,
                bibleId,
                bookId,
                chapterNumber: ch.number,
                status: ch.status,
                assignedUserId: assignedUserId ?? null,
                peerCheckerId: peerCheckerId ?? null,
                isAiEnabled: ch.isAiEnabled ?? false,
              })
              .returning({ id: chapter_assignments.id });
            // Mirror the service's initial-history writes so history views
            // aren't empty for seeded rows.
            await db.insert(chapter_assignment_status_history).values({
              chapterAssignmentId: inserted.id,
              status: ch.status,
            });
            const assignmentHistory = [
              { userId: assignedUserId, role: 'drafter' as const },
              { userId: peerCheckerId, role: 'peer_checker' as const },
            ].filter(
              (h): h is { userId: number; role: 'drafter' | 'peer_checker' } => h.userId != null
            );
            if (assignmentHistory.length) {
              await db.insert(chapter_assignment_assigned_user_history).values(
                assignmentHistory.map((h) => ({
                  chapterAssignmentId: inserted.id,
                  assignedUserId: h.userId,
                  role: h.role,
                  status: ch.status,
                }))
              );
            }
          } else {
            const drifted: Partial<typeof chapter_assignments.$inferInsert> = {};
            if (row.status !== ch.status) drifted.status = ch.status;
            if (row.assignedUserId !== (assignedUserId ?? null)) {
              drifted.assignedUserId = assignedUserId ?? null;
            }
            if (row.peerCheckerId !== (peerCheckerId ?? null)) {
              drifted.peerCheckerId = peerCheckerId ?? null;
            }
            if (row.isAiEnabled !== (ch.isAiEnabled ?? false)) {
              drifted.isAiEnabled = ch.isAiEnabled ?? false;
            }
            if (Object.keys(drifted).length) {
              await db
                .update(chapter_assignments)
                .set(drifted)
                .where(eq(chapter_assignments.id, row.id));
              const effectiveStatus = drifted.status ?? row.status;
              if (drifted.status) {
                await db.insert(chapter_assignment_status_history).values({
                  chapterAssignmentId: row.id,
                  status: drifted.status,
                });
              }
              const reassigned = [
                { userId: drifted.assignedUserId, role: 'drafter' as const },
                { userId: drifted.peerCheckerId, role: 'peer_checker' as const },
              ].filter(
                (h): h is { userId: number; role: 'drafter' | 'peer_checker' } => h.userId != null
              );
              if (reassigned.length) {
                await db.insert(chapter_assignment_assigned_user_history).values(
                  reassigned.map((h) => ({
                    chapterAssignmentId: row.id,
                    assignedUserId: h.userId,
                    role: h.role,
                    status: effectiveStatus,
                  }))
                );
              }
            }
          }
        }
      }
    }
  }
}
