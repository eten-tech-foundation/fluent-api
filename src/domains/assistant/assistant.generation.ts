import type { BriefingEvent } from './assistant.client';
import type { loadAssistantConfig } from './assistant.config';

import { BtServantClient } from './assistant.client';

const activeUsers = new Set<number>();

/** Process-local admission for new work only; completed reads and joins need no lease. */
export function acquireGeneration(userId: number): (() => void) | null {
  if (activeUsers.has(userId)) return null;
  activeUsers.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUsers.delete(userId);
  };
}

/** Private work ends on caller cancellation; retained work releases from its producer. */
export function releasePrivateGeneration(
  events: AsyncIterable<BriefingEvent>,
  release: () => void,
  signal: AbortSignal
): AsyncGenerator<BriefingEvent> {
  signal.addEventListener('abort', release, { once: true });
  if (signal.aborted) release();
  return (async function* () {
    try {
      yield* events;
    } finally {
      signal.removeEventListener('abort', release);
      release();
    }
  })();
}

export function createAssistantClient(
  config: NonNullable<ReturnType<typeof loadAssistantConfig>>,
  warn: (data: unknown, message: string) => void,
  budgets = config.budgets
) {
  return new BtServantClient({
    baseUrl: config.baseUrl,
    engineKey: config.engineKey,
    org: config.org,
    ...budgets,
    warn,
  });
}
