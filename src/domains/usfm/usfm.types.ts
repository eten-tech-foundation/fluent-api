import type { Readable } from 'node:stream';

import type { VerseMarkers } from '@/db/schema';

export interface VerseData {
  bookId: number;
  bookCode: string;
  bookName: string;
  chapterNumber: number;
  verseNumber: number;
  translatedContent: string | null;
  /** Structural context stored with the verse (#263); null on legacy rows. */
  markers: VerseMarkers;
}

/** Book-level USFM fields authored per project unit and book (#263; fluent-web#398). */
export interface BookFields {
  runningHeader: string | null;
  bookTitle: string | null;
  /** \toc1 long name; omitted from the export when null or blank. */
  tocLongName: string | null;
  /** \toc2 short name; also supplies \mt, and \h when that is unset. */
  tocShortName: string | null;
  /** \toc3 abbreviation; omitted from the export when null or blank. */
  tocAbbreviation: string | null;
}

export interface BookInfo extends BookFields {
  bookId: number;
  bookCode: string;
  bookName: string;
}

export interface ExportResult {
  stream: Readable;
  cleanup: () => void;
}
