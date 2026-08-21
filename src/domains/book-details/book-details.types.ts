import { z } from '@hono/zod-openapi';

// Book-level USFM fields a translator authors once per book (#263; fluent-web#398).
// Each becomes one plain line in the export (\h, \mt or \toc1-\toc3), so a value
// can never carry marker syntax or line breaks. An empty or whitespace-only string
// clears the field back to null, which for \h and \mt means "fall back to the
// book's display name" and for the \toc fields means "omit the line".
// The rejected ranges are the Unicode control (Cc) and line/paragraph separator
// (Zl, Zp) categories, written out as literal ranges rather than \p{…} escapes so
// the pattern published in the OpenAPI document means the same thing to a
// consumer validating without the unicode flag.
// The vertical bar is rejected for the same reason as the backslash: USFM 3.0
// reserves it as the attribute separator, and the grammar this repo parses with
// excludes it from marker text (tree-sitter-usfm3 `text: /[^\\|]+/`), so a single
// pipe anywhere in \h, \mt or a \toc line makes the whole exported book
// unparseable rather than merely odd-looking.
// eslint-disable-next-line no-control-regex -- rejecting them is the point
const BOOK_FIELD_PATTERN = /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029\\|]*$/;

const bookFieldSchema = z
  .string()
  .max(200)
  .regex(
    BOOK_FIELD_PATTERN,
    'must not contain backslashes, pipes, control characters or line breaks'
  )
  .transform((value) => (value.trim() === '' ? null : value.trim()))
  .nullable();

/**
 * Every writable book field, in export order. The PATCH refine, its message and
 * the repository's sparse `set` ladder all derive from this list, so adding a
 * sixth field cannot leave one of the three silently behind.
 */
export const BOOK_DETAIL_FIELDS = [
  'runningHeader',
  'bookTitle',
  'tocLongName',
  'tocShortName',
  'tocAbbreviation',
] as const;

export type BookDetailField = (typeof BOOK_DETAIL_FIELDS)[number];

export const updateBookDetailsSchema = z
  .object({
    runningHeader: bookFieldSchema.optional().openapi({
      description:
        'USFM \\h running header. Empty or null falls back to \\toc2, then to the book display name.',
      example: 'Gênesis',
    }),
    bookTitle: bookFieldSchema.optional().openapi({
      description:
        'Legacy USFM \\mt book title. Not written by the fluent-web#398 metadata dialog and never displayed by it; it is preserved as-is and still supplies \\mt whenever tocShortName is null.',
      example: 'O Primeiro Livro de Moisés',
    }),
    tocLongName: bookFieldSchema.optional().openapi({
      description: 'USFM \\toc1 long book name. Null or empty omits the line from the export.',
      example: 'Gênesis',
    }),
    tocShortName: bookFieldSchema.optional().openapi({
      description:
        'USFM \\toc2 short book name. Also supplies the \\mt main title, and the \\h running header when that is unset. Null or empty omits the line.',
      example: 'Gênesis',
    }),
    tocAbbreviation: bookFieldSchema.optional().openapi({
      description: 'USFM \\toc3 book abbreviation. Null or empty omits the line from the export.',
      example: 'Gn',
    }),
  })
  .refine((body) => BOOK_DETAIL_FIELDS.some((field) => body[field] !== undefined), {
    message: `at least one of ${BOOK_DETAIL_FIELDS.join(', ')} is required`,
  });

export type UpdateBookDetailsInput = z.infer<typeof updateBookDetailsSchema>;

export const bookDetailsSchema = z.object({
  bookId: z.number().int(),
  bookCode: z.string(),
  bookName: z.string(),
  runningHeader: z.string().nullable(),
  bookTitle: z.string().nullable(),
  tocLongName: z.string().nullable(),
  tocShortName: z.string().nullable(),
  tocAbbreviation: z.string().nullable(),
});

export const bookDetailsListSchema = z.array(bookDetailsSchema);

export type BookDetails = z.infer<typeof bookDetailsSchema>;
