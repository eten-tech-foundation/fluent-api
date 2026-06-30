import type { PgBoss } from 'pg-boss';

import type { AiSuggestionTriggerJob } from '@/lib/queue';

import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';
import { triggerAiSuggestions } from '@/lib/services/fluent-ai/fluent-ai.client';

import type { WorkerMetricsHooks } from './usfm-export.worker';

interface JobPayload {
  id: string;
  data: AiSuggestionTriggerJob;
}

export async function registerAiTriggerWorker(
  boss: PgBoss,
  metricsHooks: WorkerMetricsHooks
): Promise<void> {
  logger.info('Registering AI suggestion trigger worker', {
    queueName: QUEUE_NAMES.AI_SUGGESTION_TRIGGER,
  });

  await boss.work<AiSuggestionTriggerJob>(
    QUEUE_NAMES.AI_SUGGESTION_TRIGGER,
    {
      batchSize: 5,
      pollingIntervalSeconds: 2,
    },
    async (jobs: JobPayload[]) => {
      logger.info('Worker received AI trigger jobs', { count: jobs.length });

      if (metricsHooks.onBatchStart) metricsHooks.onBatchStart(jobs.length);

      const startTime = Date.now();
      try {
        const payloads = jobs.map((j) => j.data);
        await triggerAiSuggestions(payloads);

        logger.info('AI trigger batch completed', { jobCount: jobs.length });
        if (metricsHooks.onJobSuccess) {
          jobs.forEach(() => metricsHooks.onJobSuccess!(Date.now() - startTime));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`AI trigger batch failed: ${errorMessage}`, { jobCount: jobs.length });
        if (metricsHooks.onJobFailure) {
          jobs.forEach(() => metricsHooks.onJobFailure!(Date.now() - startTime));
        }
        throw error;
      } finally {
        if (metricsHooks.onBatchEnd) metricsHooks.onBatchEnd(jobs.length);
      }
    }
  );

  logger.info('AI trigger worker registered', {
    queueName: QUEUE_NAMES.AI_SUGGESTION_TRIGGER,
  });
}
