import type { JobWithMetadata, PgBoss } from 'pg-boss';

import type { AiSuggestionTriggerJob } from '@/lib/queue';

import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';
import { triggerAiSuggestions } from '@/lib/services/fluent-ai/fluent-ai.client';

import type { WorkerMetricsHooks } from './usfm-export.worker';

export async function registerAiTriggerWorker(
  boss: PgBoss,
  metricsHooks: WorkerMetricsHooks
): Promise<void> {
  logger.info('Registering AI suggestion trigger worker', {
    queueName: QUEUE_NAMES.AI_SUGGESTIONS,
  });

  await boss.work<AiSuggestionTriggerJob>(
    QUEUE_NAMES.AI_SUGGESTIONS,
    {
      batchSize: 5,
      pollingIntervalSeconds: 2,
      // For createdOn: the batch is forwarded in queue order.
      includeMetadata: true,
    },
    async (jobs: JobWithMetadata<AiSuggestionTriggerJob>[]) => {
      logger.info('Worker received AI trigger jobs', { count: jobs.length });

      if (metricsHooks.onBatchStart) metricsHooks.onBatchStart(jobs.length);

      const startTime = Date.now();
      try {
        // pg-boss returns a batch in no particular order, and fluent-ai runs jobs in the order it
        // stored them, giving everything in one request the same timestamp. So the jobs go oldest
        // first, one request each, and a pericope's title still runs before its verses (#394 QA).
        const ordered = [...jobs].sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime());
        for (const job of ordered) {
          await triggerAiSuggestions([job.data]);
        }

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
    queueName: QUEUE_NAMES.AI_SUGGESTIONS,
  });
}
