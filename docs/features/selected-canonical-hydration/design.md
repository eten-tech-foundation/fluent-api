# Selected-canonical verse-audio hydration

Issue: [#454](https://github.com/eten-tech-foundation/fluent-api/issues/454)

## Dependency / baseline

| Item                               | Value                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Stacked on                         | open [PR #391](https://github.com/eten-tech-foundation/fluent-api/pull/391) (`mrace/feature/377-accept-pericope-verse-range-audio`) |
| PR #391 head (implementation base) | `d1baee7d84fd078d785e0db45329f8820dcefe1f`                                                                                          |
| `main` verified at issue write     | `4bccdc12a19b06f3a30a89dab0a7fa645131eb67`                                                                                          |
| Upload / range persistence         | Reused from #377 / PR #391 — this change is **read/hydration only**                                                                 |

## Goal

Chapter `GET /verse-audio` and unit `GET /verse-audio/{projectUnitId}/{bibleTextId}` return a testable selected-canonical contract for verse and multi-verse pericope units so Observer / Peer Check offline draft download can bind cache identity without inventing a take.

## Contract

Exact wire examples: [`reference/wire-contract.json`](./reference/wire-contract.json).

| Field                                                          | Rule                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                                                       | `projectUnitId` + `bibleTextId` (shared anchor) + recording `id`                                                                                                                                                                                                                                                                          |
| `granularity` / coverage                                       | From the exact active take when `activeTakeId` matches `takes[].id`; otherwise from denormalized recording state. Verse units hydrate inclusive `startChapter`/`startVerse`/`endChapter`/`endVerse` from `bible_texts` on read (persistence may still store nulls). Pericope uses persisted bounds, including cross-chapter `endChapter`. |
| `activeTakeId` + `takes[].contentHash` + `takes[].downloadUrl` | Exact match only. Clients cache on `activeTakeId` + that take’s `contentHash`.                                                                                                                                                                                                                                                            |
| Top-level `downloadUrl`                                        | Set only when `activeTakeId` matches a take (same URL as that take). **`null`** when `activeTakeId` is null or unmatched — no `takes[length-1]` / invent-take fallback.                                                                                                                                                                   |
| `conflictStatus`                                               | Preserved. Matching-base / legacy upload may advance `activeTakeId` while status remains `conflict`. Only `POST .../resolve` marks `resolved`. No invented playback UX.                                                                                                                                                                   |
| List membership                                                | Still by anchor `bible_texts` chapter. Cross-chapter pericopes appear on the anchor/start chapter with full end bounds.                                                                                                                                                                                                                   |
| Auth                                                           | Existing verse-audio read gates unchanged.                                                                                                                                                                                                                                                                                                |

## Out of scope

- Upload / range persistence (PR #391)
- Observer-only grant API, `updatedAfter`, playback UX, chapter stage advancement
- Expanding chapter list to non-anchor overlapping units
