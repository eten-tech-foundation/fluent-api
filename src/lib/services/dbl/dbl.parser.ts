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
    const verseNumString = match[1].split('-')[0];
    const verseNumber = Number.parseInt(verseNumString, 10);

    const text = match[2]
      .replace(/[<>«»]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (verseNumber > 0 && text.length > 0) {
      verses.set(verseNumber, text);
    }
  }

  if (expectedVerseCount !== undefined && verses.size !== expectedVerseCount) {
    console.warn(
      `[dbl.parser] Verse count mismatch: expected ${expectedVerseCount}, parsed ${verses.size}`
    );
  }

  return verses;
}
