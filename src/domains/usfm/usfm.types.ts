import type { Readable } from 'node:stream';

export interface VerseData {
  bookId: number;
  bookCode: string;
  bookName: string;
  chapterNumber: number;
  verseNumber: number;
  translatedContent: string | null;
}

export interface BookInfo {
  bookId: number;
  bookCode: string;
  bookName: string;
}

export interface ExportResult {
  stream: Readable;
  cleanup: () => void;
}
