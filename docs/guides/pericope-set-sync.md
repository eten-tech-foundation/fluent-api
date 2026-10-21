# Pericope set sync

`GET /pericope-sets/{id}` downloads all groups in a pericope set in one request.
It requires an active, authenticated user, like `GET /pericope-sets`.

Each group has the chapter endpoint's fields plus `bookCode`:

```json
[
  {
    "bookCode": "MRK",
    "pericopeNumber": "42",
    "pericopeTitle": "Jesus predicts his death",
    "verses": [
      { "chapterNumber": 8, "verseNumber": 38 },
      { "chapterNumber": 9, "verseNumber": 1 }
    ]
  }
]
```

This is an illustrative group. The response includes every reference in each
group, even when it crosses a chapter boundary. Group numbers are scoped to a
book. FCBH numbers keep the chapter endpoint's `section_number` format.
Groups are ordered by book ID and their first verse; references are ordered by
chapter and verse.

Add `?bookCode=MRK` to download one book. Codes are trimmed and converted to
uppercase. Unknown set IDs or book codes return `404`. Invalid IDs or malformed
book codes return `400`. An existing empty set, or a known book without coverage
in that set, returns `200` with `[]`.

Save the response and its `ETag` header under the request URL. Send that header
value as `If-None-Match` when refreshing the same set or book slice:

```http
GET /pericope-sets/1?bookCode=MRK
Authorization: Bearer <session-token>
If-None-Match: "<saved-etag>"
```

An unchanged response returns `304` with no body. Keep the saved payload. A
changed response returns `200` with the new payload and ETag. The strong ETag is
the SHA-256 hash of the response JSON, so changes to group titles or references
invalidate it. `If-None-Match` also accepts weak tags, lists of tags, and `*`.

Both successful statuses include `ETag` and `Cache-Control: private, no-cache`.
Clients may store the response privately but must revalidate before reusing it.
Authentication and input validation still run for conditional requests. ETag is
exposed through CORS for browser clients. The chapter endpoint keeps its existing
response shape and behavior.
