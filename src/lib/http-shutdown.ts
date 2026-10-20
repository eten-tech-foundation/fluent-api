export const HTTP_DRAIN_TIMEOUT_MS = 5_000;

interface ClosableHttpServer {
  close: (callback: (error?: Error) => void) => unknown;
  closeAllConnections?: () => void;
}

export type HttpDrainOutcome = 'drained' | 'forced';

/** Stops listener admission immediately and force-closes if active responses miss the deadline. */
export function closeHttpServer(
  server: ClosableHttpServer,
  timeoutMs = HTTP_DRAIN_TIMEOUT_MS
): Promise<HttpDrainOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (outcome: HttpDrainOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish('forced');
    }, timeoutMs);

    server.close((error) => {
      if (settled) return;
      if (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      } else finish('drained');
    });
  });
}

/** Starts close before producer settlement so new requests cannot enter during shutdown. */
export async function stopHttpAdmissionAndDrain(
  server: ClosableHttpServer,
  settleActiveResponses: () => Promise<void>,
  timeoutMs = HTTP_DRAIN_TIMEOUT_MS
): Promise<HttpDrainOutcome> {
  const listener = closeHttpServer(server, timeoutMs);
  const [, outcome] = await Promise.all([settleActiveResponses(), listener]);
  return outcome;
}
