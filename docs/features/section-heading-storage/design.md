# Section heading preservation

Issue: https://github.com/eten-tech-foundation/fluent-api/issues/288

## Existing model

The API already accepts an ordered `markers.headings` array on a translated verse. Each entry has its own heading marker and text and appears before that verse; heading words do not belong to `content`. This was added with the paragraph-marker storage work. No new table or migration is needed for this supported shape.

There are three gaps: USFM import appends a mid-chapter heading to the preceding verse, chapter assignment content omits stored markers, and export can leave a verse inside a heading when no opening paragraph marker was stored.

## Contract

- Keep the existing authenticated translated-verse write and read APIs and marker validation. A heading is anchored before the following verse, in stored order.
- Parse supported heading paragraphs separately from verse content and carry them through both immediate and delayed USFM materialization. A verse with a heading but empty text must still be persisted when its source verse exists.
- Validate imported heading structure using the existing marker schema before inserting rows. Unsupported heading lengths/counts must fail explicitly instead of silently discarding structure. Preserve raw uploaded files and retry idempotency.
- Share the verse-body serialization used by chapter content and ZIP export. After a heading, emit the following verse's opening paragraph marker, or a default paragraph when none exists.
- Preserve the existing output for legacy rows without markers and all existing book-header behavior. Keep headings outside verse nodes after parsing the generated USFM.
- Chapter assignment content must select stored markers and pass them into the serializer. Existing authorization and transactions remain unchanged.

## Scope and dependency

This change completes the existing heading-before-verse model, including multiple headings. It does not introduce a general block editor, inline heading formatting, a new paragraph import feature, a UI change, or AI-generated titles. Arbitrary unsupported USFM remains in the original uploaded file; this is not a lossless serializer for all USFM constructs.

USFM `sd`/`sd1`–`sd4` markers are [textless semantic divisions](https://docs.usfm.bible/usfm/3.1/para/titles-sections/sd.html), not textual titles. Import leaves their layout in the original file instead of creating an empty heading that would fail validation. For compatibility with records already accepted by the existing API, serialization emits stored `sd` markers as bare divisions. Any invalid text attached to those legacy markers remains in storage but is not rendered. Representing semantic divisions explicitly is outside this text-heading change.

Import is implemented in the still-open project-creation PR: https://github.com/eten-tech-foundation/fluent-api/pull/305. This feature branch starts from that PR's reviewed head, `af841a9250ce210e4ef78e9eed176926bdee6cdb`, and a draft PR should target its existing branch `feat/419-usfm-import-create`. Do not merge or modify that shared branch as part of this work.

The repository deletes merged branches automatically. Retarget the dependent PR to `main` before merging the import PR, then synchronize it with main and verify its diff. The full pre-merge workflow only runs for non-draft PRs targeting main, so local validation is required while the change is stacked.

## Validation

First reproduce the wrong heading/verse association and missing paragraph in tests using the real USFM parser. Cover heading order, empty verse text, chapter boundaries, heading validation, cached and delayed materialization, chapter content, and legacy output. Exercise real database persistence, update, read and export in an isolated PostgreSQL database. Run the complete test suite, lint, formatting, typecheck, build and the repository docs check before finishing.
