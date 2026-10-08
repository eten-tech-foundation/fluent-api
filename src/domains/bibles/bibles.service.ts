import { bibleKey } from '@/domains/bible-provider-resources/bible-provider-resources.identity';
import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { ok } from '@/lib/types';

import type { Bible, BibleResponse, CreateBible, UpdateBible } from './bibles.types';

import * as repo from './bibles.repository';

// ─── Response mapping ─────────────────────────────────────────────────────────

type ProviderResource = NonNullable<
  Extract<Awaited<ReturnType<typeof resources.getById>>, { ok: true }>['data']
>;

function identityKey(provider: string, externalId: string) {
  return JSON.stringify([provider, externalId]);
}

function mapBibleResponse(
  bible: Bible,
  text: ProviderResource | null,
  audio: ProviderResource | null
) {
  return {
    id: bible.id,
    name: bible.name,
    abbreviation: bible.abbreviation,
    languageId: bible.languageId,
    hasAudio: bible.hasAudio,
    provider: bible.provider,
    ttsLicenseStatus: text?.ttsLicenseStatus ?? 'unknown',
    textBibleKey: bible.externalId
      ? bibleKey({ provider: bible.provider, externalId: bible.externalId })
      : null,
    selectedRecordingKey: audio ? bibleKey(audio) : null,
  } satisfies BibleResponse;
}

async function toBibleResponse(bible: Bible) {
  const text = bible.externalId
    ? await resources.getByProviderIdentity(bible.provider, bible.externalId)
    : ok(null);
  if (!text.ok) return text;
  const audio = bible.audioResourceId ? await resources.getById(bible.audioResourceId) : ok(null);
  if (!audio.ok) return audio;
  return ok(mapBibleResponse(bible, text.data, audio.data));
}

async function toBibleResponses(bibles: Bible[]) {
  const identities = new Map<string, { provider: Bible['provider']; externalId: string }>();
  const recordingIds = new Set<number>();
  for (const bible of bibles) {
    if (bible.externalId)
      identities.set(identityKey(bible.provider, bible.externalId), {
        provider: bible.provider,
        externalId: bible.externalId,
      });
    if (bible.audioResourceId !== null) recordingIds.add(bible.audioResourceId);
  }

  const [texts, recordings] = await Promise.all([
    resources.getByProviderIdentities([...identities.values()]),
    resources.getByIds([...recordingIds]),
  ]);
  if (!texts.ok) return texts;
  if (!recordings.ok) return recordings;

  const textsByIdentity = new Map(
    texts.data.map((resource) => [identityKey(resource.provider, resource.externalId), resource])
  );
  const recordingsById = new Map(recordings.data.map((resource) => [resource.id, resource]));
  return ok(
    bibles.map((bible) =>
      mapBibleResponse(
        bible,
        bible.externalId
          ? (textsByIdentity.get(identityKey(bible.provider, bible.externalId)) ?? null)
          : null,
        bible.audioResourceId === null ? null : (recordingsById.get(bible.audioResourceId) ?? null)
      )
    )
  );
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function searchSourceBibles(query: string) {
  return repo.searchSourceBibles(query);
}

export async function getAllBibles() {
  const result = await repo.getAll();
  if (!result.ok) return result;
  return toBibleResponses(result.data);
}

export function getBibleRecordById(id: number) {
  return repo.getById(id);
}

export async function getBibleById(id: number) {
  const result = await repo.getById(id);
  if (!result.ok) return result;
  return toBibleResponse(result.data);
}

export async function getBiblesByLanguageId(languageId: number) {
  const result = await repo.getByLanguageId(languageId);
  if (!result.ok) return result;
  return toBibleResponses(result.data);
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
