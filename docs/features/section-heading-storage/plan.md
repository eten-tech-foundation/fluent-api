# Section Heading Preservation Implementation Plan

> For agentic workers: use the subagent-driven-development workflow for implementation and review.

**Goal:** Preserve the text and position of supported section headings through import, translated-verse storage, chapter content and export.

**Architecture:** Reuse `markers.headings`, with headings anchored before the next verse. Carry that structure through USFM materialization and use one shared chapter/verse-body serializer for both export and chapter content.

**Tech Stack:** TypeScript, Hono, Zod, Drizzle, PostgreSQL, Vitest, usfm-grammar.

**Spec:** [design.md](design.md)

## Global Constraints

- Node >=24.14.0; use the existing lockfile and dependencies.
- No new database migration or API route; preserve existing authentication and transactions.
- Keep legacy exports byte-for-byte and preserve existing book metadata behavior.
- Imported headings must follow the existing marker schema, and materialization must remain idempotent.
- Work only in this isolated branch based on the open USFM import PR; do not mutate its shared branch.
- Do not publish comments, reviews or Slack messages. The controller handles any draft PR.

## Task 1: Complete the supported heading round trip

**Files:**

- Modify `src/lib/usfm-converter.ts` and its USJ verse tests.
- Add a shared verse-body serializer under `src/lib/` if needed to avoid copying the export loop.
- Modify `src/domains/projects/usfm-import.service.ts` and its tests.
- Modify `src/domains/usfm/usfm.service.ts` and its tests.
- Modify `src/domains/chapter-assignments/chapter-assignments.repository.ts` and focused content tests.

**Interfaces:**

- Consume the existing `VerseMarkers`, `USFM_HEADING_MARKERS`, and `verseMarkersSchema` from the database schema.
- Extend `UsjVerseText` with optional `markers: NonNullable<VerseMarkers>`; callers with no headings retain their existing shape.
- Extend the converter's `VerseData` with optional `markers: VerseMarkers`, retaining legacy callers.
- Keep the existing public signatures of `parseUsfmFiles`, `materializeUsfmImport`, `getContent`, `generateUSFMText`, and `createUSFMStreamForBook`.

- [x] Add failing parser tests using this real input:

```usfm
\id GEN
\c 1
\p
\v 1 First.
\s1 The Creation
\p
\v 2 Second.
```

The result must contain `First.` and `Second.` as verse text and `{ headings: [{ marker: 's1', text: 'The Creation' }] }` only on the second verse's markers.

- [x] Add failing export and chapter-content tests for a mid-chapter heading without a stored paragraph. Expect the contiguous output `\\s1 The Creation\n\\p\n\\v 2 Second.\n`, and a parsed USJ heading node containing only `The Creation`.
- [x] Add materialization tests for cached creation input and reparsing after delayed source ingestion. Both must insert heading markers separately from content; an empty verse with a heading must be stored. Reject invalid heading structures before any write. Preserve the existing conflict-do-nothing behavior.
- [x] Run the affected suites and record the expected failures before production edits.
- [x] Implement a heading-aware USJ walk: flush the preceding verse when a heading paragraph is encountered; retain ordered heading text until the following verse; never append heading text to a verse. Validate at the import persistence boundary.
- [x] Extract the existing body serializer and use it for both export and generated chapter content. Use `isChapterStart || hasHeadings` for a default opening paragraph when no stored opening marker exists. Pass selected markers through chapter-content generation.
- [x] Run the affected suites, then the full precheck and build. Self-review the complete diff and record tests in the task report.
- [x] Commit only implementation and tests; the controller owns feature documentation and the final integration verification.

## Controller verification

- [x] Review the task for spec compliance and code quality.
- [x] Run an isolated PostgreSQL smoke covering import, persisted markers, edits, chapter content, export, and idempotent re-materialization.
- [x] Finish documentation and run final checks.
- [ ] Obtain a whole-branch review and address actionable findings.
- [ ] Push the new feature branch and create a draft PR against the existing import branch, with the dependency stated clearly.
