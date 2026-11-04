import { convertUSFMToUSJ, usjToVerseTexts } from './usfm-converter';

/** Runs the real parser over a USFM string and returns its verse rows, throwing on any error. */
export function versesOf(usfm: string) {
  const usj = convertUSFMToUSJ(usfm);
  if (!usj.ok) throw new Error(usj.error.message);
  const verses = usjToVerseTexts(usj.data);
  if (!verses.ok) throw new Error(verses.error.message);
  return verses.data;
}
