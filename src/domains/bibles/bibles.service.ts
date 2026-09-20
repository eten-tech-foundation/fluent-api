import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.repository';
import { bibleKey } from '@/domains/bible-provider-resources/identity';
import { ok } from '@/lib/types';

import type { Bible, BibleResponse, CreateBible, UpdateBible } from './bibles.types';

import * as repo from './bibles.repository';

// ─── Response mapping ─────────────────────────────────────────────────────────

async function toBibleResponse(bible: Bible) {
  const text = bible.externalId
    ? await resources.getByProviderIdentity(bible.provider, bible.externalId)
    : ok(null);
  if (!text.ok) return text;
  const audio = bible.audioResourceId ? await resources.getById(bible.audioResourceId) : ok(null);
  if (!audio.ok) return audio;
  return ok<BibleResponse>({
    id: bible.id,
    name: bible.name,
    abbreviation: bible.abbreviation,
    languageId: bible.languageId,
    hasAudio: bible.hasAudio,
    provider: bible.provider,
    ttsLicenseStatus: text.data?.ttsLicenseStatus ?? 'unknown',
    textBibleKey: bible.externalId
      ? bibleKey({ provider: bible.provider, externalId: bible.externalId })
      : null,
    selectedRecordingKey: audio.data ? bibleKey(audio.data) : null,
  });
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function searchSourceBibles(query: string) {
  return repo.searchSourceBibles(query);
}

export async function getAllBibles() {
  const result = await repo.getAll();
  if (!result.ok) return result;
  const mapped = await Promise.all(result.data.map(toBibleResponse));
  const failed = mapped.find((entry) => !entry.ok);
  if (failed && !failed.ok) return failed;
  return ok(mapped.flatMap((entry) => (entry.ok ? [entry.data] : [])));
}

export async function getBibleById(id: number) {
  const result = await repo.getById(id);
  if (!result.ok) return result;
  return toBibleResponse(result.data);
}

export async function getBiblesByLanguageId(languageId: number) {
  const result = await repo.getByLanguageId(languageId);
  if (!result.ok) return result;
  const mapped = await Promise.all(result.data.map(toBibleResponse));
  const failed = mapped.find((entry) => !entry.ok);
  if (failed && !failed.ok) return failed;
  return ok(mapped.flatMap((entry) => (entry.ok ? [entry.data] : [])));
}

export async function createBible(data: CreateBible) {
  const result = await repo.create(data);
  if (!result.ok) return result;
  return toBibleResponse(result.data);
}

export async function updateBible(id: number, data: UpdateBible) {
  const result = await repo.update(id, data);
  if (!result.ok) return result;
  return toBibleResponse(result.data);
}

export function deleteBible(id: number) {
  return repo.remove(id);
}
