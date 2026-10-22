# Bibles reference provider resources by FK; provider facts live only on the resource

`bibles` used to carry its DBL text identity (`provider`, `external_id`) and a
provider fact (`has_audio`) directly, and was matched to its licence row in
`bible_provider_resources` by value — a cast join across two provider enums,
with nothing forcing the row to exist. That is how every DBL Bible came to read
`unknown`.

**Decision:** provider facts — identity, licence status and notice, audio
availability — live only on the provider resource. A Bible holds Fluent's own
records and two FKs: `text_resource_id` (the text it is built from, unique) and
`audio_resource_id` (the selected recording, Fluent's choice). One
`resource_provider` enum; `bible_provider` is dropped. A resource's role comes
from which FK points at it — no `kind` column, because one Aquifer identity can
be both text and recording.

**Considered:** moving licence columns onto `bibles` instead — rejected,
because reference Bibles have licence facts but no `bibles` row; putting the
recording link on the recording row — rejected, because one recording can serve
more than one Bible.

**Consequences:** the DBL sync upserts the provider resource first, then links
the Bible to it. Dropping the old columns is a separate, later release: deploy
runs migrations before the new code is live, so the old code must keep working
against the expanded schema for one release.
