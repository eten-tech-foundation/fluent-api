import type { PgBoss } from 'pg-boss';

import type { AiSuggestionTriggerJob } from '@/lib/queue';

import { triggerAiSuggestions } from '@/lib/ai-client';
import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';

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

      try {
        await Promise.all(
          jobs.map(async (job) => {
            const startTime = Date.now();
            try {
              await triggerAiSuggestions([job.data]);
              logger.info('AI trigger job completed', { jobId: job.id });
              if (metricsHooks.onJobSuccess) metricsHooks.onJobSuccess(Date.now() - startTime);
            } catch (error) {
              logger.error('AI trigger job failed', { jobId: job.id, error });
              if (metricsHooks.onJobFailure) metricsHooks.onJobFailure(Date.now() - startTime);
              throw error;
            }
          })
        );
      } finally {
        if (metricsHooks.onBatchEnd) metricsHooks.onBatchEnd(jobs.length);
      }
    }
  );

  logger.info('AI trigger worker registered', {
    queueName: QUEUE_NAMES.AI_SUGGESTION_TRIGGER,
  });
}
