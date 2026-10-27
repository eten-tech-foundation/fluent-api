import usfmGrammar from 'usfm-grammar';

import type { VerseMarkers } from '@/db/schema';
import type { Result, USJDocument, USJNode } from '@/lib/types';

import { MAX_VERSE_PARAGRAPHS, USFM_HEADING_MARKERS, USFM_PARAGRAPH_MARKERS } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';
import { isUSFMSemanticDivisionMarker, serializeUSFMVerseBody } from '@/lib/usfm-verse-serializer';

const { USFMParser } = usfmGrammar;

export interface VerseData {
  bookId: number;
  bookCode: string;
  bookName: string;
  chapterNumber: number;
  verseNumber: number;
  translatedContent: string | null;
  markers?: VerseMarkers;
}

/**
 * Validates USFM input text
 * @param usfmText - The USFM text to validate
 * @returns Result with void data on success, error on failure
 */
function validateUSFMInput(usfmText: string): Result<void> {
  if (!usfmText || usfmText.trim().length === 0) {
    return {
      ok: false,
      error: { code: ErrorCode.VALIDATION_ERROR, message: 'USFM text cannot be empty' },
    };
  }
  return { ok: true, data: undefined };
}

/**
 * Converts USFM formatted text to USJ (Unified Scripture JSON) format
 * @param usfmText - The USFM text to convert
 * @returns Result containing USJDocument on success, error on failure
 */
function convertUSFMToUSJ(usfmText: string): Result<USJDocument> {
  // Validate input
  const validationResult = validateUSFMInput(usfmText);
  if (!validationResult.ok) {
    return validationResult as Result<USJDocument>;
  }

  try {
    const parser = new USFMParser(usfmText);

    // Check for parser errors
    if (parser.errors && parser.errors.length > 0) {
      logger.warn('USFM parser errors:', { errors: parser.errors });
      return err(ErrorCode.USFM_INVALID);
    }

    const usjContent = parser.toUSJ();

    return {
      ok: true,
      data: usjContent as USJDocument,
    };
  } catch (error) {
    logger.error('Error converting USFM to USJ:', error);
    return {
      ok: false,
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Failed to convert USFM to USJ',
      },
    };
  }
}

/**
 * Generates USFM formatted text from verse data
 * NOTE: Currently uses hardcoded conversion values. May need to implement
 * a builder pattern in the future for more robust/flexible implementation.
 * @param verses - Array of verse data to convert
 * @returns USFM formatted text string
 */
function generateUSFMText(verses: VerseData[]): string {
  if (verses.length === 0) {
    return '';
  }

  const { bookCode, bookName } = verses[0];
  let usfmText = `\\id ${bookCode}\n\\h ${bookName}\n\\mt1 ${bookName}\n`;

  let currentChapter: number | null = null;

  for (const verse of verses) {
    const isChapterStart = currentChapter !== verse.chapterNumber;
    if (isChapterStart) {
      usfmText += `\\c ${verse.chapterNumber}\n`;
      currentChapter = verse.chapterNumber;
    }
    usfmText += serializeUSFMVerseBody(verse, isChapterStart);
  }

  return `${usfmText}\n`;
}

export interface UsjVerseText {
  chapterNumber: number;
  verseNumber: number;
  text: string;
  markers?: NonNullable<VerseMarkers>;
}

/** Prose, poetry and list items contribute verse text; other structure stays in the raw file. */
const BODY_TEXT_MARKERS = new Set([
  'p',
  'm',
  'po',
  'pr',
  'cls',
  'pmo',
  'pm',
  'pmc',
  'pmr',
  'pi',
  'pi1',
  'pi2',
  'pi3',
  'mi',
  'nb',
  'pc',
  'ph',
  'ph1',
  'ph2',
  'ph3',
  'b',
  'q',
  'q1',
  'q2',
  'q3',
  'q4',
  'qr',
  'qc',
  'qa',
  'qm',
  'qm1',
  'qm2',
  'qm3',
  'qd',
  'li',
  'li1',
  'li2',
  'li3',
  'li4',
  'lim',
  'lim1',
  'lim2',
  'lim3',
  'lim4',
]);

type VerseHeadings = NonNullable<NonNullable<VerseMarkers>['headings']>;
type VerseParagraphs = NonNullable<NonNullable<VerseMarkers>['paragraphs']>;
type ParagraphMarker = VerseParagraphs[number]['marker'];

const paragraphMarkers = new Set<string>(USFM_PARAGRAPH_MARKERS);
const isParagraphMarker = (marker: string): marker is ParagraphMarker =>
  paragraphMarkers.has(marker);

/** One stretch of a verse inside a single paragraph. */
interface VerseSegment {
  text: string;
  /** Unset for a paragraph the verse row cannot store, such as a verse nested in a heading. */
  marker?: ParagraphMarker;
  /** The verse number is the first thing in this paragraph. */
  openedByVerse: boolean;
}

interface VerseInProgress {
  chapterNumber: number;
  verseNumber: number;
  segments: VerseSegment[];
  headings?: VerseHeadings;
}

/**
 * Joins a verse's stretches into the text a row stores, with the paragraphs it opens or crosses.
 * Same rules as fluent-web's save path (`usjToPericopeVerses`), so the editor reads imported rows
 * the way it writes its own: stretches are trimmed and joined with one space; offset 0 means the
 * verse opens the paragraph its words start in; a later stretch opens a paragraph at its offset
 * in the joined text. A paragraph without words has nothing to anchor it, unless the verse has no
 * words at all and keeps the paragraph its number opened.
 */
function joinSegments(segments: VerseSegment[]): { text: string; paragraphs: VerseParagraphs } {
  const trimmed = segments.map((segment) => ({
    ...segment,
    text: segment.text.replace(/\s+/g, ' ').trim(),
  }));
  const kept = trimmed.filter((segment) => segment.text !== '');
  const paragraphs: VerseParagraphs = [];

  const firstText = trimmed.findIndex((segment) => segment.text !== '');
  const opener = trimmed[Math.max(firstText, 0)];
  if (opener?.marker && (firstText > 0 || opener.openedByVerse)) {
    paragraphs.push({ marker: opener.marker, offset: 0 });
  }
  let offset = 0;
  kept.forEach((segment, index) => {
    if (index > 0) {
      offset += 1; // the joining space
      if (segment.marker) paragraphs.push({ marker: segment.marker, offset });
    }
    offset += segment.text.length;
  });

  return {
    text: kept.map((segment) => segment.text).join(' '),
    paragraphs,
  };
}

/**
 * Flattens a USJ document into one entry per verse: chapters are top-level milestones, verses
 * are milestones inside paragraphs, and a verse's text is every string and character-style run
 * between its milestone and the next one, across paragraph boundaries. A bridged verse ("3-4")
 * is filed under its first number. Heading words, note apparatus and anything before the first
 * verse are not included in verse text. Supported headings are preserved as markers on the
 * following verse, and body paragraphs (prose, poetry, lists) as the verse's paragraph markers
 * (fluent-web#314); other unsupported structure remains available in the raw imported file. A
 * trailing heading has no following verse and remains only in the verbatim imported file.
 */
export function usjToVerseTexts(usj: USJDocument): Result<UsjVerseText[]> {
  const verses: UsjVerseText[] = [];
  const headingMarkers = new Set<string>(USFM_HEADING_MARKERS);
  let chapter: number | null = null;
  let current: VerseInProgress | null = null;
  let pendingHeadings: VerseHeadings = [];
  // The body paragraph being walked, and whether a verse number or words came first in it.
  // Null elsewhere, so a verse nested in a heading or an unsupported block opens no paragraph.
  let paragraph: { marker?: ParagraphMarker; hasContent: boolean } | null = null;

  const flush = () => {
    if (!current) return;
    const { text, paragraphs: found } = joinSegments(current.segments);
    // A row stores at most MAX_VERSE_PARAGRAPHS; rejecting the verse would fail the whole file.
    const paragraphs = found.slice(0, MAX_VERSE_PARAGRAPHS);
    if (found.length > paragraphs.length) {
      logger.warn('Imported USFM verse kept only its first paragraphs', {
        chapterNumber: current.chapterNumber,
        verseNumber: current.verseNumber,
        paragraphs: found.length,
        kept: paragraphs.length,
      });
    }
    const markers = {
      ...(current.headings ? { headings: current.headings } : {}),
      ...(paragraphs.length > 0 ? { paragraphs } : {}),
    };
    verses.push({
      chapterNumber: current.chapterNumber,
      verseNumber: current.verseNumber,
      text,
      ...(markers.headings || markers.paragraphs ? { markers } : {}),
    });
    current = null;
  };

  const addText = (text: string) => {
    if (!current) return;
    current.segments[current.segments.length - 1].text += text;
    if (paragraph && text.trim() !== '') paragraph.hasContent = true;
  };

  const textOf = (node: USJNode | string): string => {
    if (typeof node === 'string') return node;
    const content = 'content' in node ? node.content : undefined;
    return Array.isArray(content) ? content.map(textOf).join('') : '';
  };

  const walk = (nodes: (USJNode | string)[]) => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        addText(node);
        continue;
      }
      switch (node.type) {
        case 'chapter': {
          flush();
          const number = Number.parseInt(node.number, 10);
          chapter = Number.isFinite(number) ? number : null;
          break;
        }
        case 'verse': {
          flush();
          const number = Number.parseInt(node.number, 10);
          if (chapter !== null && Number.isFinite(number)) {
            current = {
              chapterNumber: chapter,
              verseNumber: number,
              segments: [
                {
                  text: '',
                  marker: paragraph?.marker,
                  openedByVerse: paragraph !== null && !paragraph.hasContent,
                },
              ],
              ...(pendingHeadings.length > 0 ? { headings: pendingHeadings } : {}),
            };
            pendingHeadings = [];
          }
          if (paragraph) paragraph.hasContent = true;
          break;
        }
        case 'char':
          addText(textOf(node));
          break;
        case 'para': {
          if (isUSFMSemanticDivisionMarker(node.marker)) {
            flush();
            const firstVerse = node.content.findIndex(
              (child) => typeof child !== 'string' && child.type === 'verse'
            );
            if (firstVerse !== -1) walk(node.content.slice(firstVerse));
            break;
          }

          if (!headingMarkers.has(node.marker)) {
            if (BODY_TEXT_MARKERS.has(node.marker)) {
              paragraph = {
                marker: isParagraphMarker(node.marker) ? node.marker : undefined,
                hasContent: false,
              };
              // The open verse continues into this paragraph until a verse number comes first.
              current?.segments.push({ text: '', marker: paragraph.marker, openedByVerse: false });
              walk(node.content);
              paragraph = null;
            } else {
              // Unsupported paragraphs can still contain real verses.
              // Keep their verse text while excluding labels before the first milestone.
              const firstVerse = node.content.findIndex(
                (child) => typeof child !== 'string' && child.type === 'verse'
              );
              if (firstVerse !== -1) walk(node.content.slice(firstVerse));
            }
            break;
          }

          flush();
          const firstVerse = node.content.findIndex(
            (child) => typeof child !== 'string' && child.type === 'verse'
          );
          const headingContent =
            firstVerse === -1 ? node.content : node.content.slice(0, firstVerse);
          const headingText = headingContent.map(textOf).join('').replace(/\s+/g, ' ').trim();
          pendingHeadings.push({
            marker: node.marker as (typeof USFM_HEADING_MARKERS)[number],
            text: headingText,
          });

          // A missing body paragraph can make the parser nest the following verse
          // in the heading node. Keep the heading prefix and still walk that verse.
          if (firstVerse !== -1) walk(node.content.slice(firstVerse));
          break;
        }
        case 'book':
          break;
        default: {
          const unsupportedNode = node as unknown as { type: string; content?: unknown };
          logger.warn('Unsupported USJ node while extracting verse text', {
            type: unsupportedNode.type,
          });
          break;
        }
      }
    }
  };

  walk(usj.content);
  flush();
  return ok(verses);
}

export { convertUSFMToUSJ, generateUSFMText };
