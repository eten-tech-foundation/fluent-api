import type { Result } from '@/lib/types';

import { logger } from '@/lib/logger';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { err, ErrorCode, ok } from '@/lib/types';

import type { BibleAudioResponse } from './bible-audio.types';

import * as booksRepo from '../../books/books.repository';
import * as biblesRepo from '../bibles.repository';

export async function getSourceAudio(
  bibleId: number,
  bookId: number,
  chapterNumber: number
): Promise<Result<BibleAudioResponse[]>> {
  // 1. Resolve internal Bible ID to get the DBL externalId
  const bibleResult = await biblesRepo.getById(bibleId);
  if (!bibleResult.ok) return bibleResult;
  const bible = bibleResult.data;

  if (!bible.externalId) {
    return ok([]);
  }

  // 2. Resolve internal Book ID to get the USFM code (e.g. 'GEN')
  const bookResult = await booksRepo.getById(bookId);
  if (!bookResult.ok) return bookResult;
  const book = bookResult.data;

  // 3. Fetch the full Bible metadata from DBL to find its associated Audio Bibles
  const dblBibleResult = await dblClient.getBible(bible.externalId);
  if (!dblBibleResult.ok) {
    logger.warn('Failed to fetch DBL Bible for audio lookup', {
      externalId: bible.externalId,
      error: dblBibleResult.error,
    });
    return dblBibleResult;
  }
  const dblBible = dblBibleResult.data;

  const audioBibles = dblBible.audioBibles;
  if (!audioBibles || audioBibles.length === 0) {
    return ok([]);
  }

  const dblChapterId = `${book.code}.${chapterNumber}`;

  // 4. Fetch all available audio chapters in parallel
  const results = await Promise.allSettled(
    audioBibles.map((audioSummary) => dblClient.getAudioChapter(audioSummary.id, dblChapterId))
  );

  const audioTracks: BibleAudioResponse[] = [];
  for (const [index, settled] of results.entries()) {
    if (settled.status === 'rejected') {
      logger.error('Upstream DBL failure while fetching audio chapters', { error: settled.reason });
      return err(ErrorCode.DBL_SERVICE_UNAVAILABLE);
    }
    const result = settled.value;
    if (!result.ok) {
      if (result.error.code === ErrorCode.DBL_AUDIO_CHAPTER_NOT_FOUND) continue;
      logger.error('Upstream DBL failure while fetching audio chapters', { error: result.error });
      return result;
    }
    const audioSummary = audioBibles[index]!;
    audioTracks.push({
      audioBibleId: audioSummary.id,
      name: audioSummary.name || audioSummary.nameLocal || dblBible.name,
      chapterId: result.data.id,
      resourceUrl: result.data.resourceUrl,
      expiresAt: result.data.expiresAt ?? null,
      timecodes: result.data.timecodes,
    });
  }

  return ok(audioTracks);
}
