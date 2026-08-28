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

1. **DBL** — when the Fluent bible is linked to DBL and audio bibles exist for the chapter. All DBL audio bibles for the chapter are returned as `items`. Each item and each `verseTimestamps` entry includes `dblAudioBibleId` so timings stay associated with their track (`bible.dblAudioBibleId` is the first track).
2. **Aquifer** — when DBL returns no tracks, or DBL is unavailable (`502`). Aquifer is matched by Fluent bible **abbreviation or name only** — never a language-default or first-catalogue fallback.
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
- `items[]`: playable URLs (`mp3` / `webm`), `sizeBytes`, `scope: "chapter"`
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
