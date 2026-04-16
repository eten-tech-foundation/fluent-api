import usfmGrammar from 'usfm-grammar';

import type { Result, USJDocument } from '@/lib/types';

import { logger } from '@/lib/logger';
import { ErrorCode } from '@/lib/types';

const { USFMParser } = usfmGrammar;

export interface VerseData {
  bookId: number;
  bookCode: string;
  bookName: string;
  chapterNumber: number;
  verseNumber: number;
  translatedContent: string | null;
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
      logger.warn('USFM parser warnings:', { errors: parser.errors });
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
  let usfmText = `\\id ${bookCode}\n\\h ${bookName}\n\\mt ${bookName}\n`;

  let currentChapter: number | null = null;

  for (const verse of verses) {
    if (currentChapter !== verse.chapterNumber) {
      usfmText += `\\c ${verse.chapterNumber}\n\\p\n`;
      currentChapter = verse.chapterNumber;
    }
    usfmText += `\\v ${verse.verseNumber} ${verse.translatedContent ?? ''}\n`;
  }

  return `${usfmText}\n`;
}

export { convertUSFMToUSJ, generateUSFMText };
