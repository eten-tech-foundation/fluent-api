# Clear `max-lines` CI Annotations — Implementation Plan

**Goal:** Remove all four `max-lines` ESLint warnings (cap: 500 counted lines, `warn` severity, applies to test files) by extracting cohesive concerns along the repo's existing module conventions. No `eslint-disable`, no cap changes.

**Architecture:** Four independent file fixes across two domains. The verse-audio domain gets a response-hydration module (`verse-audio.responses.ts`), a takes-table repository (`verse-audio-takes.repository.ts`, mirroring the existing `storage-objects.repository.ts` extraction), and a 3-way test split (per the `ai-suggestions.activation.service.test.ts` precedent) with shared fixtures (`verse-audio.test-fixtures.ts`, per the `pericopes.test-fixtures.ts` precedent). Chapter-assignments gets a progress-rollup repository extraction.

**Out of scope:** `ubuntu-latest` pinning (GitHub migrates it to Ubuntu 26 on 2026-10-19 — handle in a separate PR if desired). No behavior changes anywhere.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest — no new dependencies.

## Global Constraints

- **Mechanical moves only.** CAS predicates, version-token bumps, sweep lock-checks, and conflict semantics move verbatim — review every moved write path against `.claude/skills/versioned-resource-writers/SKILL.md` (especially: no `?? undefined` into `.set()` payloads; sweeps re-check unreferenced-ness under the parent row lock).
- **Naming uses domain nouns, not suffixes.** No `*.mapper.ts`/`*.helpers.ts`/`*.utils.ts` exist in `src/` — new modules are named `verse-audio.responses.ts`, `verse-audio-takes.repository.ts` (mirrors the `verse_audio_takes` table), `chapter-assignments.progress.repository.ts`. All kebab-case per `unicorn/filename-case`.
- **Test names must not change.** Split test files keep `describe('verse-audio service') > describe('<fn>')` wrappers so vitest test identity is preserved.
- **`vi.mock()` calls are hoisted per-file** — each split test file redeclares the narrowed `vi.mock` blocks it needs; only plain fixtures move to `*.test-fixtures.ts`.
- **`verse-audio.route.test.ts:82-89` mocks `./verse-audio.service` wholesale** — all six service exports stay in `verse-audio.service.ts`; only private helpers move, so the mock is unaffected.
- If an honest split lands a file marginally over 500 counted lines, retune the `it`-block boundaries — do not disable the rule.
- One PR, one commit per task below.

---

### Task 1: Extract response hydration from `verse-audio.service.ts` (512 → ~340)

**Files:**

- Create: `src/domains/verse-audio/verse-audio.responses.ts`
- Modify: `src/domains/verse-audio/verse-audio.service.ts`

**Interfaces:**

- Produces (exported from `verse-audio.responses.ts`):
  - `loadUnitResponse` — consumed by service's `uploadRecording`, `getRecording`, `listChapterRecordings`, `resolveConflict`
  - `buildRecordingResponses` — consumed by `listChapterRecordings`
  - `collectLegacyStorageObjectIds`, `fallbackBlobKey`, `legacyBlobName`, `isLegacyContentHash`, `contentHashOf` — re-imported by the service's `deleteRecording`/`reclaimOrphanedStorageObjects` sweep paths
  - private (not exported): `toIso`, `storageKeysById`, `resolveDownloadUrl`, `takeWithUrl`, `withTakesAndUrl`, `LEGACY_CONTENT_HASH_PREFIX`
- Consumes: `storageRepo.getByIds`, `repo.get`, `repo.listTakesByRecordingIds`, `@/lib/audio-storage` URL/blob helpers, `./verse-audio.types`.
- Stays in service: `storeTakeBytes` (upload-only), all six exports, `reclaimOrphanedStorageObjects` (still imported by `src/index.ts:4`).

- [ ] Move current lines 31–203 (`LEGACY_CONTENT_HASH_PREFIX` through `loadUnitResponse`) into `verse-audio.responses.ts`, exporting exactly the symbols the service still needs.
- [ ] In `verse-audio.service.ts`, replace the moved block with imports from `./verse-audio.responses`.
- [ ] Run `npm run lint -- src/domains/verse-audio/` — service under 500, no new warnings; `npm run typecheck`.
- [ ] Run `npm run test -- verse-audio` — all existing tests green unchanged.

---

### Task 2: Split `verse-audio.service.test.ts` (982 → 3 files, each under 500)

**Files:**

- Create: `src/domains/verse-audio/verse-audio.test-fixtures.ts` — shared `hashOf`, `record`, `take`, `uploadInput` fixtures
- Create: `src/domains/verse-audio/verse-audio.service.upload.test.ts` — happy path, input validation, idempotent/duplicate-hash re-uploads, storage failure, `storage object tracking` (it is an upload-path test)
- Create: `src/domains/verse-audio/verse-audio.service.conflicts.test.ts` — conflict-preservation, clean CAS, CAS-loss/stale-token, legacy no-token paths
- Modify: `src/domains/verse-audio/verse-audio.service.test.ts` — keeps `getRecording`, `listChapterRecordings`, `resolveConflict`, `deleteRecording`, `reclaimOrphanedStorageObjects`

**Estimated counted lines after split:** upload ~430–470, conflicts ~370–390, remainder ~400–420 (verify with eslint; adjust `it`-block boundaries if needed — the upload file is the tightest).

- [ ] Create `verse-audio.test-fixtures.ts` with the four shared fixtures/helpers; keep the `orphan` factory local to the reclaim tests (it's only used there).
- [ ] Create `verse-audio.service.upload.test.ts`: imports + narrowed `vi.mock`s (`@/lib/audio-storage`, `./storage-objects.repository`, `./verse-audio.repository`, `@/lib/logger`) + `beforeEach` defaults for the mocks upload tests actually touch + `describe('verse-audio service') > describe('uploadRecording')` (plus `describe('storage object tracking')` inside the same wrapper).
- [ ] Create `verse-audio.service.conflicts.test.ts` the same way, holding the CAS/conflict/legacy-token `it` blocks under `describe('uploadRecording')` — test names stay identical.
- [ ] Trim `verse-audio.service.test.ts` to the five remaining describes; remove the `insertRecording` mock entry if present (Task 3 deletes the function).
- [ ] Run `npm run test -- verse-audio` — identical test count, all green.
- [ ] Run `npm run lint -- src/domains/verse-audio/` — all three test files under 500.

---

### Task 3: Extract takes cluster from `verse-audio.repository.ts` (568 → ~320)

**Files:**

- Create: `src/domains/verse-audio/verse-audio-takes.repository.ts`
- Modify: `src/domains/verse-audio/verse-audio.repository.ts`, `src/domains/verse-audio/verse-audio.service.ts`, `src/domains/verse-audio/verse-audio.responses.ts` (import re-points), `src/domains/verse-audio/verse-audio.repository.test.ts` (move takes tests or leave importing from new path)

**Interfaces:**

- Produces: `takeSelection`, `listTakesByRecordingIds`, `findTakeByContentHash`, `getTakeById`, `insertTake`, `listTakesForRecording`, `pruneSupersededTakes` — moved verbatim, including the sweep's lock-and-recheck CAS semantics.
- Shared: `mapForeignKeyViolation`/`RETRYABLE_STORAGE_FK_CONSTRAINTS` stay exported from `verse-audio.repository.ts`; the takes repo imports them (avoids a third module for ~16 lines).
- Deletion: `insertRecording` (lines ~249–285) is dead in prod — remove it, its `repository.test.ts` block (~lines 94–114), and its `service.test.ts` mock entries.

- [ ] Delete `insertRecording` and its test/mocks; confirm nothing references it (`grep -r insertRecording src/`).
- [ ] Create `verse-audio-takes.repository.ts` with the seven moved members; import `mapForeignKeyViolation`/`RETRYABLE_STORAGE_FK_CONSTRAINTS` from `./verse-audio.repository`.
- [ ] Update importers: `verse-audio.service.ts` (`repo.*` calls for takes fns → takes repo), `verse-audio.responses.ts` (`listTakesByRecordingIds`), any other `listTakes*`/`findTakeByContentHash`/`getTakeById`/`insertTake`/`pruneSupersededTakes` callers (`grep -r`).
- [ ] Move takes-related tests in `verse-audio.repository.test.ts` to `verse-audio-takes.repository.test.ts` if that keeps the original test file's cohesion; otherwise update imports in place. Check whether `verse-audio.repository.test.ts` itself then exceeds/needs the split — only split if it's over 500.
- [ ] Update `vi.mock('./verse-audio.repository')` declarations — moved functions need mocking at `./verse-audio-takes.repository` in the three service test files.
- [ ] `npm run test -- verse-audio` green; `npm run lint` clean.

---

### Task 4: Extract progress rollup from `chapter-assignments.repository.ts` (553 → ~418)

**Files:**

- Create: `src/domains/chapter-assignments/chapter-assignments.progress.repository.ts`
- Modify: `src/domains/chapter-assignments/chapter-assignments.repository.ts`, `src/domains/chapter-assignments/chapter-assignments.service.ts` (caller at ~line 64), `src/domains/chapter-assignments/chapter-assignments.repository.test.ts` (progress tests at ~lines 128–223)

**Interfaces:**

- Produces: `hasConflictRollupSql`, `findAssignmentsProgress` — moved verbatim.
- Only two callers: `chapter-assignments.service.ts` and the repository test.

- [ ] Move `hasConflictRollupSql` + `findAssignmentsProgress` to the new module; re-point the two importers (add `vi.mock` for the new path where tests mock the repository).
- [ ] `npm run test -- chapter-assignments` green; `npm run lint` clean.

---

### Task 5: Final verification

- [ ] `npm run lint` — zero `max-lines` warnings repo-wide.
- [ ] `npm run format:check` — clean.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run test` — full suite green, same test count as before the refactor (modulo the deleted `insertRecording` test).
- [ ] Self-review diff against `.claude/skills/versioned-resource-writers/SKILL.md` — confirm CAS/sweep code moved verbatim.
