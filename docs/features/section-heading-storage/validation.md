# Section heading validation

## Regression evidence

The base branch passed all 591 tests in 65 files. Ten new regressions failed before implementation across the parser, import service, exporter and chapter-content reader. The same four focused suites now pass all 46 tests.

The failures showed heading words appended to the preceding verse, missing imported markers, omission of a heading on an empty verse, acceptance of more headings than the API supports, missing paragraph boundaries after a mid-chapter heading, and missing headings in chapter content.

The final review also found two compatibility regressions involving semantic divisions: valid textless `sd` input blocked materialization, and legacy stored `sd` entries containing text broke chapter reads. Seven additional failing regressions reproduced these cases, including all five `sd` spellings. After the correction, all 53 tests in the four affected suites passed. The PostgreSQL smoke also reproduced the valid-file import failure and passed after the correction.

## Local checks

On Node 24.14.0, the initial implementation passed all precheck commands (`npm run lint`, `npm run format:check`, `npm run typecheck`, and `npm test -- --run`): ESLint reported no errors, Prettier and TypeScript passed, and all 600 tests in 66 files passed. ESLint still reports three existing file-length warnings in the verse-audio repository and service files. `npm run build` and the documentation-structure check also passed. After the semantic-division fix, the four affected suites passed all 53 tests, and focused ESLint, Prettier, TypeScript and diff checks passed again.

## PostgreSQL round trip

All 29 existing migrations were applied to a new isolated PostgreSQL 16 database. The integration smoke used the real repositories and services, with two project units to exercise both cached creation input and delayed reparsing after source ingestion.

The smoke failed on the base: `First.` became `First. A Later Section`, `Second.` became `Second. A Heading Before Empty Text`, and the empty verse was omitted. It passed with the implementation:

- Ordered headings remained separate from verse text across two chapters.
- A verse with empty text and a heading was persisted.
- Editing the verse and its heading through the existing write schema and service survived subsequent reads.
- Chapter content contained standalone heading paragraphs, with no verse inside a heading.
- Export restored a body paragraph after a heading even when the stored structure did not include an opening paragraph.
- Re-materializing an import did not overwrite an edited verse or heading, or create duplicate rows.
- The original uploaded file remained unchanged.
- Project deletion removed its imported-file rows through the existing cascade.
- Valid textless semantic divisions did not block cached or delayed import, and the original file retained their layout.
- A legacy stored division with an invalid text payload remained readable as chapter content; serialization omitted those invalid words while leaving the stored marker object and verse text unchanged.

This tests database persistence and service contracts; it is not a browser or route-authentication test. No shared database or external storage was used.

## CI scope

The feature is stacked on the open USFM import PR. The repository's full pre-merge workflow runs only for non-draft PRs targeting `main`; it does not validate a draft against the import branch. Local validation is recorded here until the dependency lands and the PR is retargeted.
