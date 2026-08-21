import { describe, expect, it } from 'vitest';

import type { BookDetails } from './book-details.types';

import {
  BOOK_DETAIL_FIELDS,
  bookDetailsSchema,
  updateBookDetailsSchema,
} from './book-details.types';

// #263 / fluent-web#398: each field becomes one plain \h, \mt or \toc line in the
// USFM export, so the schema is the only thing standing between user input and
// marker injection.
//
// Rejections are asserted by issue, never by `.success` alone: the object default
// is strip, so an unknown key vanishes before the refine runs and the refine then
// fails for the wrong reason. A boolean-only assertion would pass whether or not
// the field under test exists at all.
function issuesFor(field: string, value: unknown) {
  const result = updateBookDetailsSchema.safeParse({ [field]: value });
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues;
}

describe('updateBookDetailsSchema', () => {
  it('accepts a plain header and trims it', () => {
    const parsed = updateBookDetailsSchema.parse({ runningHeader: '  Gênesis  ' });
    expect(parsed.runningHeader).toBe('Gênesis');
  });

  it('clears a field on empty string or null', () => {
    expect(updateBookDetailsSchema.parse({ runningHeader: '   ' }).runningHeader).toBeNull();
    expect(updateBookDetailsSchema.parse({ bookTitle: null }).bookTitle).toBeNull();
  });

  it('accepts a body naming only a TOC field', () => {
    const parsed = updateBookDetailsSchema.parse({ tocShortName: 'Gênesis' });
    expect(parsed.tocShortName).toBe('Gênesis');
  });

  it('trims and clears the TOC fields the same way', () => {
    expect(updateBookDetailsSchema.parse({ tocAbbreviation: '  Gn  ' }).tocAbbreviation).toBe('Gn');
    expect(updateBookDetailsSchema.parse({ tocLongName: '   ' }).tocLongName).toBeNull();
    expect(updateBookDetailsSchema.parse({ tocShortName: null }).tocShortName).toBeNull();
  });

  it('rejects values that could smuggle USFM syntax into the export, in every field', () => {
    // Backslash and line breaks smuggle markers; the control and separator
    // characters below (NUL, ESC, U+2028, U+2029) can break the line-oriented
    // export just as effectively. The pipe is USFM 3.0's attribute separator, and
    // one anywhere in a header value makes the exported book unparseable.
    const values = [
      'Genesis\n\\id EXO',
      'Genesis\\mt',
      'a\rb',
      'a\u0000b',
      'a\u001Bb',
      'a\u2028b',
      'a\u2029b',
      'Gen|esis',
      'Genesis | Genèse',
    ];
    for (const field of BOOK_DETAIL_FIELDS) {
      for (const value of values) {
        expect(
          issuesFor(field, value).some(
            (issue) => issue.path[0] === field && issue.code === 'invalid_string'
          ),
          `${field} should reject ${JSON.stringify(value)}`
        ).toBe(true);
      }
    }
  });

  it('rejects a value over 200 characters', () => {
    expect(
      issuesFor('tocLongName', 'x'.repeat(201)).some(
        (issue) => issue.path[0] === 'tocLongName' && issue.code === 'too_big'
      )
    ).toBe(true);
  });

  it('requires at least one field, and names every field in the message', () => {
    const result = updateBookDetailsSchema.safeParse({});
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues[0].message;
    for (const field of BOOK_DETAIL_FIELDS) {
      expect(message).toContain(field);
    }
  });

  it('leaves an absent field absent, so the update does not touch it', () => {
    const parsed = updateBookDetailsSchema.parse({ bookTitle: 'First Book of Moses' });

    // Key absence, asserted on the whole key set rather than field by field.
    // The previous form, `'x' in parsed && parsed.x !== undefined`, was false when
    // the key was missing AND false when the key was present holding undefined, so
    // it passed either way and pinned nothing (#275 review). The distinction is the
    // point: the repository's sparse `set` ladder is built from keys whose value is
    // not undefined, so a key that materialised holding undefined would still be
    // skipped — but `Object.keys` also catches a key materialising with any other
    // value, which would silently overwrite a stored field with a default.
    expect(Object.keys(parsed)).toEqual(['bookTitle']);
  });
});

describe('bookDetailsSchema', () => {
  // This schema is the 200 body of both routes and the only written description of
  // it. @hono/zod-openapi publishes it into the OpenAPI document that fluent-web
  // generates its client from, but never validates a response against it, so the
  // declared shape and the shape the repository actually returns are joined by
  // nothing but convention. This block is that join (#275 review).
  //
  // All five writable fields populated rather than mostly null, so a field missing
  // from the parsed output is a visible hole instead of a null that reads the same
  // either way. Typed as `BookDetails` on purpose: as an annotated object literal
  // it also puts tsc's excess-property check behind the same contract.
  const row: BookDetails = {
    bookId: 1,
    bookCode: 'GEN',
    bookName: 'Genesis',
    runningHeader: 'Gênesis',
    bookTitle: 'O Primeiro Livro de Moisés',
    tocLongName: 'Gênesis',
    tocShortName: 'Gênesis',
    tocAbbreviation: 'Gn',
  };

  it('round-trips the whole payload, so no field can be dropped from the declared 200 shape', () => {
    // Equality on the parsed output, not `.success`, which is what the previous
    // form of this test asserted and why it pinned nothing. zod objects strip
    // unknown keys, so removing a field from the schema leaves this fixture
    // parsing happily — it just comes back one field lighter, which is precisely
    // the silent narrowing that would break the generated client.
    //
    // Measured before writing this: with `tocAbbreviation` deleted from the schema,
    // all 31 tests in this domain still passed, and the only complaint anywhere in
    // the repo came from tsc, about an object literal in book-details.route.test.ts
    // — a test fixture. No production code noticed at all.
    const parsed = bookDetailsSchema.parse(row);

    expect(parsed).toEqual(row);
  });

  it('declares every writable field in the response, not only in the request', () => {
    // The request and response schemas are written out separately, so a sixth
    // field added to BOOK_DETAIL_FIELDS and wired into the PATCH body can be
    // forgotten here. The round-trip above would not catch that on its own: its
    // fixture is hand-written, so it would simply not mention the new field either.
    for (const field of BOOK_DETAIL_FIELDS) {
      expect(Object.keys(bookDetailsSchema.shape)).toContain(field);
    }
  });

  it('requires the TOC fields to be present, not optional', () => {
    const { tocLongName, tocShortName, tocAbbreviation, ...withoutToc } = row;
    void tocLongName;
    void tocShortName;
    void tocAbbreviation;

    expect(bookDetailsSchema.safeParse(withoutToc).success).toBe(false);
  });
});
