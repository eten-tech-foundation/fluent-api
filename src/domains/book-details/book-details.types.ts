import { z } from '@hono/zod-openapi';

// Book-level USFM fields a translator authors once per book (#263; fluent-web#398).
// Each becomes one plain line in the export (\h or \mt), so a value can never
// carry marker syntax or line breaks. An empty or whitespace-only string clears
// the field back to null, which means "fall back to the book's display name".
// The rejected ranges are the Unicode control (Cc) and line/paragraph separator
// (Zl, Zp) categories, written out as literal ranges rather than \p{…} escapes so
// the pattern published in the OpenAPI document means the same thing to a
// consumer validating without the unicode flag.
// eslint-disable-next-line no-control-regex -- rejecting them is the point
const BOOK_FIELD_PATTERN = /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029\\]*$/;

const bookFieldSchema = z
  .string()
  .max(200)
  .regex(BOOK_FIELD_PATTERN, 'must not contain backslashes, control characters or line breaks')
  .transform((value) => (value.trim() === '' ? null : value.trim()))
  .nullable();

export const updateBookDetailsSchema = z
  .object({
    runningHeader: bookFieldSchema.optional().openapi({
      description: 'USFM \\h running header. Empty or null falls back to the book display name.',
      example: 'Gênesis',
    }),
    bookTitle: bookFieldSchema.optional().openapi({
      description: 'USFM \\mt book title. Empty or null falls back to the book display name.',
      example: 'O Primeiro Livro de Moisés',
    }),
  })
  .refine((body) => body.runningHeader !== undefined || body.bookTitle !== undefined, {
    message: 'at least one of runningHeader or bookTitle is required',
  });

export type UpdateBookDetailsInput = z.infer<typeof updateBookDetailsSchema>;

export const bookDetailsSchema = z.object({
  bookId: z.number().int(),
  bookCode: z.string(),
  bookName: z.string(),
  runningHeader: z.string().nullable(),
  bookTitle: z.string().nullable(),
});

export const bookDetailsListSchema = z.array(bookDetailsSchema);

export type BookDetails = z.infer<typeof bookDetailsSchema>;
