import type { VerseMarkers } from '@/db/schema';

export interface USFMVerseBodyData {
  verseNumber: number;
  translatedContent: string | null;
  markers?: VerseMarkers;
}

/** Serializes the structural blocks and text belonging to one verse. */
export function serializeUSFMVerseBody(verse: USFMVerseBodyData, isChapterStart: boolean): string {
  const content = verse.translatedContent ?? '';
  const headings = verse.markers?.headings ?? [];

  // Stored paragraph starts for this verse, defensively bounded: offsets past the
  // content are dropped rather than corrupting the output. Offset 0 (the verse
  // opens a paragraph) is valid even while the verse is still empty.
  const paragraphs = (verse.markers?.paragraphs ?? []).filter(
    (paragraph) => paragraph.offset === 0 || paragraph.offset < content.length
  );
  const opening = paragraphs.find((paragraph) => paragraph.offset === 0);

  let body = '';
  for (const heading of headings) {
    body += `\\${heading.marker} ${heading.text}\n`;
  }

  if (opening) {
    body += `\\${opening.marker}\n`;
  } else if (isChapterStart || headings.length > 0) {
    // A heading is a block of its own. The verse that follows still needs a body
    // paragraph, including when the heading appears in the middle of a chapter.
    body += '\\p\n';
  }

  // A mid-text offset splits the verse across paragraphs: the text continues
  // after the marker without a new \v, which is exactly how USFM writes it.
  let text = '';
  let cursor = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.offset === 0) continue;
    text += `${content.slice(cursor, paragraph.offset)}\n\\${paragraph.marker}\n`;
    cursor = paragraph.offset;
  }
  text += content.slice(cursor);

  return `${body}\\v ${verse.verseNumber} ${text}\n`;
}
