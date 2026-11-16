import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  trackTrace: vi.fn(),
  trackMetric: vi.fn(),
  trackException: vi.fn(),
}));
const environment = vi.hoisted(() => ({ nodeEnv: 'production' }));
vi.mock('@/env', () => ({
  default: {
    get NODE_ENV() {
      return environment.nodeEnv;
    },
    APPLICATIONINSIGHTS_CONNECTION_STRING: 'test-only',
  },
}));
vi.mock('applicationinsights', () => ({
  default: { setup: () => ({ start: vi.fn() }), defaultClient: client },
}));

beforeEach(() => {
  environment.nodeEnv = 'production';
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('logger metric() seam', () => {
  it('calls client.trackMetric with name, value and dimensions in production', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // Dynamic import so mocks are wired before the module initializes.
    const { logger } = await import('@/lib/logger');

    logger.metric('worker_queue_size', 42, { queue: 'usfm-export' });

    expect(client.trackMetric).toHaveBeenCalledWith({
      name: 'worker_queue_size',
      value: 42,
      properties: { queue: 'usfm-export' },
    });
  });

  it('calls client.trackMetric without dimensions when none are passed', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { logger } = await import('@/lib/logger');

    logger.metric('worker_rss_mb', 128);

    expect(client.trackMetric).toHaveBeenCalledWith({
      name: 'worker_rss_mb',
      value: 128,
      properties: undefined,
    });
  });

  it('keeps a visible production log line alongside the custom metric', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { logger } = await import('@/lib/logger');

    logger.metric('worker_active_jobs', 3, { queue: 'ai-suggestions' });

    expect(consoleSpy).toHaveBeenCalledWith(
      '[metric] worker_active_jobs=3',
      expect.stringContaining('ai-suggestions')
    );
  });

  it('does not change an existing log method output', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { logger } = await import('@/lib/logger');

    logger.info('Worker heartbeat', { uptimeSeconds: 300 });

    expect(client.trackTrace).toHaveBeenCalledWith({
      message: 'Worker heartbeat {"uptimeSeconds":300}',
      severity: 1,
      properties: { _formatParams: [{ uptimeSeconds: 300 }] },
    });
    expect(client.trackMetric).not.toHaveBeenCalled();
  });

  it('writes a visible structured metric through the development Pino logger', async () => {
    environment.nodeEnv = 'development';
    const { logger } = await import('@/lib/logger');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    logger.metric('worker_queue_size', 42, { queue: 'usfm-export' });

    expect(info).toHaveBeenCalledWith(
      {
        metric: 'worker_queue_size',
        value: 42,
        dimensions: { queue: 'usfm-export' },
      },
      '[metric] worker_queue_size=42'
    );
    expect(client.trackMetric).not.toHaveBeenCalled();
  });
});
