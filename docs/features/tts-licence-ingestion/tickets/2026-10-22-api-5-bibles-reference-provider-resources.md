# Bibles reference provider resources by FK

> **Status: DRAFT** — not yet filed. Board: Fluent (#4) → `In Progress (Product)`.
> Suggested labels: `enhancement`, `ready-for-agent` · QA path: `DevQA` · Priority: P1

**Parent feature:** [`tts-licence-ingestion`](../plan.md) — Ticket API-5, between Phase 1 and Phase 2.
**Repo:** `fluent-api`.
**Working branch:** `feat/tts-licence-ingestion` (in `fluent-api`). Work on that branch directly, or branch from it (`git switch -c <your-branch> origin/feat/tts-licence-ingestion`) and target your PR at it, so the plan, design and ADR context travel with the ticket. The feature branch merges to `main` once the phase's tickets are done.
**Blocked by:** API-1, API-2 shipped (keeps the schema change off the summit path).
**Blocks:** API-4 (its derived-status sync is written against the FK).
**Decision record:** [ADR 0004](../../../adr/0004-bibles-reference-provider-resources-by-fk.md).

## Problem

`bibles` and `bible_provider_resources` overlap:

- `bibles.provider` + `external_id` duplicate the provider resource's identity.
  The two are joined by value with a cast across two enums
  (`chapter-assignments-progress.repository.ts:152` calls it "deferred
  maintenance"), and nothing forces the licence row to exist.
- Two provider enums: `bible_provider` (`dbl`) and `resource_provider`
  (`dbl/aquifer/youversion`).
- `bibles.has_audio` is a DBL fact about the text edition, stored on the
  Fluent record.

Rule (glossary: **Bible**, **Provider resource**): provider facts live on the
provider resource; Fluent's records and choices live on the Bible.

## Target model

| `bibles`                                                                  | `bible_provider_resources`                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `id`, `language_id`, `name`, `abbreviation`, timestamps                   | `id`, `provider` (`resource_provider`), `external_id` — unique together |
| **`text_resource_id`** FK → bpr, unique, nullable (seed Bibles)           | `tts_license_status`, `license_notice`, `display_name`                  |
| `audio_resource_id` FK → bpr (unchanged — the selected recording)         | **`has_audio`** boolean, not null, default false                        |
| ~~`provider`~~, ~~`external_id`~~, ~~`has_audio`~~ — dropped in release 2 |                                                                         |

No `kind` column: a resource's role comes from which FK points at it.
`bible_books.has_audio` (per book) is unchanged.

## Release 1 — expand and switch (this PR)

Deploy runs `db:migrate` **before** the new code is live
(`.github/workflows/deploy.yml`), so this release must leave the old columns in
place and readable.

**Migration**

1. `ALTER TABLE bible_provider_resources ADD has_audio boolean NOT NULL DEFAULT false`.
2. `ALTER TABLE bibles ADD text_resource_id integer REFERENCES bible_provider_resources(id) ON DELETE RESTRICT`, plus a unique index `WHERE text_resource_id IS NOT NULL`.
3. Backfill missing resources (rows API-1 already wrote keep their status):
   `INSERT INTO bible_provider_resources (provider, external_id, display_name) SELECT provider::text::resource_provider, external_id, name FROM bibles WHERE external_id IS NOT NULL ON CONFLICT DO NOTHING`.
   New rows get the column default `unknown` (deny), which is correct for anything API-1 didn't cover.
4. Link: `UPDATE bibles b SET text_resource_id = r.id FROM bible_provider_resources r WHERE r.provider::text = b.provider::text AND r.external_id = b.external_id`.
5. Copy: `UPDATE bible_provider_resources r SET has_audio = b.has_audio FROM bibles b WHERE b.text_resource_id = r.id`.
6. Replace the 0037 trigger function: bump `bibles` where `text_resource_id = NEW.id OR audio_resource_id = NEW.id` (no value match), and add `has_audio` to the watched columns.

**Code: read and write through the FK only**

- `dbl-bible-sync.ts`: upsert the text resource first (`RETURNING id`), then upsert `bibles` with `text_resource_id`. Upsert conflict target becomes `bibles(text_resource_id)`. `has_audio` is written to the resource. The abbreviation-reuse map keys on the joined `external_id`. API-1's insert-only status rule still holds.
- `bibles.repository.ts` (`searchSourceBibles`, `getAll`, …): join `text_resource_id` for `provider`/`hasAudio`.
- `bibles.service.ts`: text facts via `text_resource_id` (`getByIds`); the identity-key batching goes away.
- `playback-audio.service.ts` `getSourcePlayback`, `chapter-assignments-progress.repository.ts` (drop the cast join), `ingest-bible-text.worker.ts`, `bible-audio.service.ts`, `dbl-book-sync.ts`: resolve DBL `external_id` / `has_audio` through the FK.
- Seeds (`bibles.ts`, `audio-demo.ts`, `bible-texts-bsb.ts`): create the resource, then link it.
- `POST`/`PATCH /bibles` (SuperAdmin only, no client callers): bodies accept `textResourceId` and stop accepting `provider`/`externalId`/`hasAudio`. Use explicit schemas rather than `insertBiblesSchema`, so release 2's drop doesn't silently change the contract.
- **Response shapes unchanged:** `provider`, `hasAudio`, `textBibleKey`, `selectedRecordingKey`, `ttsLicenseStatus` are now derived from the resource. Web and mobile need no changes.

Nothing in `src/` may read `bibles.provider`, `bibles.external_id` or `bibles.has_audio` after this release. Mark them `@deprecated` in `schema.ts`.

## Release 2 — contract (follow-up PR, next release)

Migration: drop index `idx_bibles_provider_external_id`, then drop `bibles.provider`, `external_id`, `has_audio`, then `DROP TYPE bible_provider`. Remove the deprecated schema fields.

## Acceptance criteria

- [ ] After migrating, every `bibles` row with an `external_id` has a `text_resource_id`, and its resource's `has_audio` equals the old `bibles.has_audio`.
- [ ] Statuses API-1/API-2 set are unchanged by the migration.
- [ ] `npm run db:sync:dbl` on a migrated DB is idempotent: no new rows and no `updated_at` bumps on a second run.
- [ ] `GET /bibles`, source search, chapter-assignment progress and source playback return identical payloads before and after (snapshot an environment's responses to compare).
- [ ] A licence or `has_audio` change on a text resource, and a change on a selected recording, each bump the linked Bible's `updated_at`.
- [ ] `grep` finds no reads of the deprecated columns in `src/` outside migrations.
- [ ] Release 2: the columns and the `bible_provider` type are gone; all tests pass.

## Tests

- Migration test (pattern: `bible-book-completion.migration.test.ts`): backfill links existing rows, preserves statuses, copies `has_audio`, and leaves seed Bibles (null `external_id`) unlinked.
- Update `catalogue-sync.watermark.integration.test.ts` for the FK-based trigger.
- `dbl-bible-sync.test.ts`, `bibles.service.test.ts`, `playback-audio.service.test.ts`, progress repository tests: switch fixtures to the FK.

## Deployment

Release 1: no manual step. The migration backfills, and the next `db:sync:dbl` writes through the FK.
Release 2: ship only after release 1 is on prod.
