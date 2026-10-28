import type {
  VerseAudioCoverageShape,
  VerseAudioRecord,
  VerseAudioTakeRecord,
} from './verse-audio.types';

export function shapeFields(shape: VerseAudioCoverageShape): VerseAudioCoverageShape {
  return {
    granularity: shape.granularity,
    startChapter: shape.startChapter,
    startVerse: shape.startVerse,
    endChapter: shape.endChapter,
    endVerse: shape.endVerse,
  };
}

export function shapeFromTake(take: VerseAudioTakeRecord): VerseAudioCoverageShape {
  return {
    granularity: take.granularity,
    startChapter: take.startChapter,
    startVerse: take.startVerse,
    endChapter: take.endChapter,
    endVerse: take.endVerse,
  };
}

export function shapeFromRecord(record: VerseAudioRecord): VerseAudioCoverageShape {
  return {
    granularity: record.granularity,
    startChapter: record.startChapter,
    startVerse: record.startVerse,
    endChapter: record.endChapter,
    endVerse: record.endVerse,
  };
}

export function shapesEqual(a: VerseAudioCoverageShape, b: VerseAudioCoverageShape): boolean {
  return (
    a.granularity === b.granularity &&
    a.startChapter === b.startChapter &&
    a.startVerse === b.startVerse &&
    a.endChapter === b.endChapter &&
    a.endVerse === b.endVerse
  );
}
