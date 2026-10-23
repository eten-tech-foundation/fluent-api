import type { Result } from '@/lib/types';

import { err, ErrorCode } from '@/lib/types';

import type { UploadRangeRecordingInput, VerseAudioWithUrl } from './verse-audio.types';

import { anchorMatchesStart, parseAndValidatePericopeRange } from './verse-audio.coverage';
import * as repo from './verse-audio.repository';
import { VERSE_AUDIO_GRANULARITY } from './verse-audio.types';
import { uploadRecording } from './verse-audio.upload.service';

/**
 * Pericope / verse-range upload: validate geometry, then reuse the verse upload
 * path with an explicit coverage shape (#377).
 */
export async function uploadRangeRecording(
  input: UploadRangeRecordingInput
): Promise<Result<VerseAudioWithUrl>> {
  if (input.granularity !== VERSE_AUDIO_GRANULARITY.PERICOPE) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

  const bibleText = await repo.getBibleTextById(input.bibleTextId);
  if (!bibleText.ok) {
    return bibleText;
  }

  const range = parseAndValidatePericopeRange({
    startChapter: input.startChapter,
    startVerse: input.startVerse,
    endChapter: input.endChapter,
    endVerse: input.endVerse,
  });
  if (!range.ok) {
    return range;
  }

  if (!anchorMatchesStart(bibleText.data, range.data.start.chapter, range.data.start.verse)) {
    return err(ErrorCode.INVALID_REFERENCE);
  }

  return uploadRecording({
    projectUnitId: input.projectUnitId,
    bibleTextId: input.bibleTextId,
    uploadedBy: input.uploadedBy,
    contentType: input.contentType,
    data: input.data,
    durationSeconds: input.durationSeconds,
    baseVersionToken: input.baseVersionToken,
    shape: {
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: range.data.start.chapter,
      startVerse: range.data.start.verse,
      endChapter: range.data.end.chapter,
      endVerse: range.data.end.verse,
    },
  });
}
