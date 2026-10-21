# Ticket 4 — Verify the concurrent-editor warning (QA)

**Priority:** P2 (QA / small fix)
**Status:** Not started.

## Context

There is **no** real-time collaborative editor by design — users are
intentionally not blocked from editing a chapter past drafting (a field
requirement), and last-write-wins on verse saves is expected. The only guard is a
warning banner shown to the 2nd+ user who opens a chapter's drafting page.

The wiring already exists end-to-end: `fluent-web` `useChapterPresence.ts` (30s
heartbeat `POST /chapter-assignments/{id}/presence`) → store `presenceWarning` →
banner in `features/header/components/index.tsx`; backed by
`chapter-assignments-presence.repository.ts` `upsertAndQueryFirstEditor`.

## Scope (verify, then fix only if needed)

1. **QA the banner fires.** With two users on the same chapter, confirm the 2nd
   user sees the warning within one heartbeat, and it clears when the first
   leaves (DELETE on unload).
2. **First-editor race.** `upsertAndQueryFirstEditor` prunes stale rows, upserts,
   and selects the first editor in one transaction but without serialization; two
   near-simultaneous registrations can disagree on who is "first." If QA shows
   flakiness, run the transaction at a stronger isolation level or
   `SELECT … FOR UPDATE` the chapter's editor rows before deciding.
3. **Presence authorization (recommended).** The presence routes use
   `authenticateUser + requirePermission(CONTENT_UPDATE)` but skip
   `requireChapterAssignmentAccess`, so any translator can probe presence for any
   `chapterAssignmentId` — this leaks editor identity across assignments. Align
   with the editor-state routes by adding
   `requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.IS_PARTICIPANT)` to
   the `POST/DELETE /chapter-assignments/{chapterAssignmentId}/presence` routes.

## Acceptance criteria

- The 2nd-editor warning reliably appears and clears in a two-user test.
- No duplicate/incorrect "first editor" under concurrent open (if observed).
