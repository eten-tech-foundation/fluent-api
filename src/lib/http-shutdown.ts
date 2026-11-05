const HTTP_DRAIN_TIMEOUT_MS = 5_000;

interface ClosableHttpServer {
  close: (callback: (error?: Error) => void) => unknown;
  closeAllConnections?: () => void;
}

type HttpDrainOutcome = 'drained' | 'forced' | 'timed_out';

/** Stops admission immediately; force-closes at the drain deadline when the server supports it. */
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
      if (!server.closeAllConnections) {
        finish('timed_out');
        return;
      }
      server.closeAllConnections();
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
