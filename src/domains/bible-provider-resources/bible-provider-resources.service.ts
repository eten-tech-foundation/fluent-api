import type { LicenseFactsPatch } from './bible-provider-resources.repository';
import type { Provider, ProviderIdentity } from './bible-provider-resources.types';

import * as repo from './bible-provider-resources.repository';

export function getById(id: number) {
  return repo.getById(id);
}

export function getByProviderIdentity(provider: Provider, externalId: string) {
  return repo.getByProviderIdentity(provider, externalId);
}

export function getByIds(ids: number[]) {
  return repo.getByIds(ids);
}

export function getByProviderIdentities(identities: ProviderIdentity[]) {
  return repo.getByProviderIdentities(identities);
}

export function touchLinkedBibles(resource: Parameters<typeof repo.touchLinkedBibles>[0]) {
  return repo.touchLinkedBibles(resource);
}

export function updateLicenseFacts(id: number, patch: LicenseFactsPatch) {
  return repo.updateLicenseFacts(id, patch);
}
