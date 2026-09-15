import type {
  AquiferAssociationResponse,
  AquiferBible,
  AquiferBibleTextResponse,
  AquiferLanguage,
  AquiferLanguageResourceCount,
  AquiferResourceCollection,
  AquiferResourceDetails,
  AquiferResourceSearchResponse,
} from '@/lib/services/aquifer/aquifer.types';
import type { Result } from '@/lib/types';

import * as aquiferClient from '@/lib/services/aquifer/aquifer.client';

import type {
  AvailableResourcesQuery,
  BiblesQuery,
  BibleTextsQuery,
  SearchResourcesQuery,
} from './aquifer-resources.types';

export async function getLanguages(): Promise<Result<AquiferLanguage[]>> {
  return aquiferClient.getLanguages();
}

export async function getAvailableResources(
  params: AvailableResourcesQuery
): Promise<Result<AquiferLanguageResourceCount[]>> {
  return aquiferClient.getAvailableResources(params);
}

export async function getResourceCollection(
  code: string
): Promise<Result<AquiferResourceCollection>> {
  return aquiferClient.getResourceCollection(code);
}

export async function searchResources(
  params: SearchResourcesQuery
): Promise<Result<AquiferResourceSearchResponse>> {
  return aquiferClient.searchResources(params);
}

export async function getResource(contentId: number): Promise<Result<AquiferResourceDetails>> {
  return aquiferClient.getResource(contentId);
}

export async function getResourceAssociations(
  parentResourceId: number
): Promise<Result<AquiferAssociationResponse>> {
  return aquiferClient.getResourceAssociations(parentResourceId);
}

export async function getBibles(query: BiblesQuery): Promise<Result<AquiferBible[]>> {
  return aquiferClient.getBibles(query.languageCode);
}

export async function getBibleText(
  bibleId: number,
  query: BibleTextsQuery
): Promise<Result<AquiferBibleTextResponse>> {
  return aquiferClient.getBibleText({
    aquiferBibleId: bibleId,
    bookCode: query.bookCode,
    startChapter: query.startChapter,
    endChapter: query.endChapter,
    includeAudio: query.includeAudio,
  });
}
