import type { CompletedBriefingArtifact } from './cache/assistant-cache.repository';

import * as repo from './assistant.repository';
import * as cacheRepo from './cache/assistant-cache.repository';

export function findProjectSourceLanguage(projectId: number): Promise<string | null> {
  return repo.findProjectSourceLanguage(projectId);
}

export function resolveCanonicalPassage(input: Parameters<typeof repo.resolveCanonicalPassage>[0]) {
  return repo.resolveCanonicalPassage(input);
}

export function findCompletedBriefing(cacheKey: string, signal?: AbortSignal) {
  return cacheRepo.findCompletedBriefing(cacheKey, signal);
}

export function publishCompletedBriefing(
  artifact: CompletedBriefingArtifact,
  signal?: AbortSignal
): Promise<boolean> {
  return cacheRepo.publishCompletedBriefing(artifact, signal);
}

export function requestExpiredBriefingCleanup(onFailure: () => void): void {
  cacheRepo.requestExpiredBriefingCleanup(onFailure);
}
