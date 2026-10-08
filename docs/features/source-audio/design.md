# Source / reference audio API

Issue: [#282](https://github.com/eten-tech-foundation/fluent-api/issues/282)

## Provider decision

| Concern               | Decision                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Primary provider**  | DBL / API.Bible when the Fluent bible row has `externalId` (see `/bibles/{id}/books/{bookId}/chapters/{n}/audio`) |
| **Fallback provider** | Aquifer Bible text API with `shouldReturnAudioData=true`                                                          |
| **Client access**     | Mobile **must** call fluent-api project routes — provider credentials stay server-side                            |
| **Distinct domain**   | `/source-audio` is source/reference playback; `/verse-audio` remains translator draft recordings                  |

### Resolution order (online playback)

1. **DBL** — when the Fluent bible is linked to DBL and audio bibles exist for the chapter. All DBL audio bibles for the chapter are returned as `items`. Each item and each `verseTimestamps` entry includes `dblAudioBibleId` so timings stay associated with their track (`bible.dblAudioBibleId` is the first track). DBL timecode `start` values are API.Bible clock strings (`HH:MM:SS.mmm`); the API converts them to `startSeconds` (seconds from chapter start). Chapters without timecodes omit `verseTimestamps` — do not invent offsets.
2. **Aquifer** — when DBL returns no tracks, or DBL is unavailable (`502`). Aquifer is matched by Fluent bible **abbreviation or name only** — never a language-default, first-catalogue, or sibling-edition fallback. If that exact matched edition reports `hasAudio: false`, the API returns empty `items` even if another edition in the language has audio.
3. **Empty `items`** — when neither provider has audio, the Aquifer catalogue is empty, or no Aquifer bible matches (HTTP 200, not 404).

Prepare Offline Tier 1 manifest uses Aquifer today (download metadata with `sizeBytes`).

## Routes

### Online playback (drafting dock)

`GET /projects/{projectId}/source-audio/{bookCode}/{chapter}`

Query:

| Param          | Required | Description                                                                   |
| -------------- | -------- | ----------------------------------------------------------------------------- |
| `languageCode` | yes      | Aquifer ISO language code (e.g. `eng`) — used for Aquifer fallback            |
| `bibleId`      | yes      | Fluent bible id from the chapter assignment                                   |
| `verse`        | no       | Echoed in response; verse timestamps included when the provider supplies them |

Response (`200`):

- `provider`: `"dbl"` or `"aquifer"`
- `items[]`: playable URLs (`mp3` / `webm`), optional provider-reported `sizeBytes`, `scope: "chapter"`
- `verseTimestamps[]`: optional verse → start offset mapping (DBL entries include `dblAudioBibleId`)
- **Empty `items`**: no source audio for this chapter (not an error)

Errors:

| Status | Meaning                                                                           |
| ------ | --------------------------------------------------------------------------------- |
| `401`  | Authentication failure                                                            |
| `404`  | Project inaccessible, Fluent bible/book not found, or Bible not linked to project |
| `502`  | Aquifer upstream failure (after DBL miss or DBL outage)                           |

### Legacy DBL-only route

`GET /bibles/{bibleId}/books/{bookId}/chapters/{chapterNumber}/audio` remains available for web/clients that already use book ids. Mobile drafting should prefer the project-scoped route above.

### Prepare Offline (Tier 1 source audio)

`GET /projects/{projectId}/source-audio/manifest`

Same query shape as translation-resources manifest (`languageCode`, `bookCode`, `startChapter`, `endChapter`) plus required `bibleId`. Returns Tier 1 Aquifer audio download metadata.

## Mobile integration

[fluent-mobile#235](https://github.com/eten-tech-foundation/fluent-mobile/issues/235) can call the chapter route with the active assignment’s `bibleId`, source `languageCode`, and current book/chapter. No new provider API key is required on the client.

## Verification tiers

Audio verification is split into three explicit tiers so the ordinary suite stays deterministic while the
database and provider paths remain reproducible.

### Default suite

```bash
npm test -- --run
```

This is the normal local and CI suite. It uses mocks, pure fixtures, and in-process databases where a test
needs SQL behavior. `vitest.config.ts` deliberately excludes `*.db.test.ts` and `*.live.test.ts`, so the
default command does not need a running Fluent database, seeded accounts, or provider credentials. DBL
reference playback is covered here with contract-shaped complete, windowless, missing-chapter, and provider
failure fixtures because live DBL timecodes were absent in the measured catalogue.

### Seeded local-database suite

```bash
npm run test:db
```

Prerequisites: the normal local Fluent platform database must be running and initialized with `db:setup`,
and `DATABASE_URL` must target that database. `vitest.db.config.ts` accepts only the `/fluent` database on
`localhost`, `127.0.0.1`, `[::1]`, or the Compose `db` hostname. This is a syntactic guard, not proof of
where a tunnel or proxy leads: never point an accepted loopback/Compose hostname at shared Dev/QA. The suite
runs serially, creates its own authentication session and temporary draft where needed, restores changed
rows, and reruns the idempotent seeds. It needs no live-provider key.

This tier proves the BSB audio seed, provider-resource constraints and lookups, assignment grain and
canonical keys, ordinary PM ownership/access, and preservation of translator work across seed reruns.

### Live-provider suite

```bash
npm run test:live
```

Prerequisites: the same initialized `/fluent` database on `localhost`, `127.0.0.1`, `[::1]`, or Compose
`db`, a working `AQUIFER_API_KEY`, and network access to Aquifer. Never route an accepted hostname through a
tunnel or proxy to shared Dev/QA. The configuration fails before collection when the key is absent, and the
test setup applies the same database hostname/path check before provider calls. The suite runs serially and
calls the real provider: seeded BSB John 3 proves complete verse windows through the authenticated project
route, while an exact IRV Hindi reference proves the measured windowless branch. Set
`SOURCE_AUDIO_CAPTURE_PATH` only for an intentional one-shot sanitized response capture; ordinary runs write
no fixture.

The live tier does not prove DBL timing or Safari/iOS playback. Both opt-in tiers are excluded from the
default suite so missing secrets, provider availability, and mutation of a developer's seeded database do
not make the ordinary CI result nondeterministic.

## Deferred optimization

Provider responses are not cached yet. Each Aquifer-backed chapter request fetches the language catalogue and chapter text; manifest generation fetches the same data for its range. A short-TTL catalogue cache (and, if measurements justify it, chapter-response caching) is deferred until request volume and provider limits establish an appropriate TTL and invalidation policy.
