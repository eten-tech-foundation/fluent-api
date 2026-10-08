export const BIBLE_RESOURCE_PROVIDERS = ['aquifer', 'youversion', 'dbl'] as const;

export type Provider = (typeof BIBLE_RESOURCE_PROVIDERS)[number];

export interface ProviderIdentity {
  provider: Provider;
  externalId: string;
}
