/**
 * Parses a plain text chapter from API.Bible into a map of verses.
 * Expects `contentType: 'text'` and `includeVerseNumbers: true`.
 *
 * Note: Drops pre-verse text and verse 0 (e.g. Psalm headings) intentionally,
 * as we only want raw scripture text.
 */
export function extractVersesFromText(
  content: string,
  expectedVerseCount?: number
): Map<number, string> {
  const verses = new Map<number, string>();

  // Extract text using `[N]` or `[N-M]` as anchors
  const regex = /\[(\d+(?:-\d+)?)\]([\s\S]*?)(?=\[\d+(?:-\d+)?\]|$)/g;

  const matches = Array.from(content.matchAll(regex));

  for (const match of matches) {
    const verseNumParts = match[1].split('-');
    const startVerse = Number.parseInt(verseNumParts[0], 10);
    const endVerse = verseNumParts.length > 1 ? Number.parseInt(verseNumParts[1], 10) : startVerse;

    const text = match[2]
      .replace(/[<>«»]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (startVerse > 0 && text.length > 0) {
      for (let v = startVerse; v <= endVerse; v++) {
        verses.set(v, text);
      }
    }
  }

  if (expectedVerseCount !== undefined && verses.size !== expectedVerseCount) {
    console.warn(
      `[dbl.parser] Verse count mismatch: expected ${expectedVerseCount}, parsed ${verses.size}`
    );
  }

  return verses;
}
