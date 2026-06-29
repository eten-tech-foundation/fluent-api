import type { PgBoss } from 'pg-boss';

import type { AiSuggestionTriggerJob } from '@/lib/queue';

import { triggerAiSuggestions } from '@/lib/ai-client';
import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';

interface JobPayload {
  id: string;
  data: AiSuggestionTriggerJob[];
}

export async function registerAiTriggerWorker(boss: PgBoss): Promise<void> {
  logger.info('Registering AI suggestion trigger worker', {
    queueName: QUEUE_NAMES.AI_SUGGESTION_TRIGGER,
  });

  await boss.work<AiSuggestionTriggerJob[]>(
    QUEUE_NAMES.AI_SUGGESTION_TRIGGER,
    {
      batchSize: 5,
      pollingIntervalSeconds: 2,
    },
    async (jobs: JobPayload[]) => {
      logger.info('Worker received AI trigger jobs', { count: jobs.length });

      const results = await Promise.allSettled(
        jobs.map(async (job) => {
          await triggerAiSuggestions(job.data);
          return { success: true };
        })
      );

      results.forEach((result, index) => {
        const jobId = jobs[index].id;
        if (result.status === 'fulfilled') {
          logger.info('AI trigger job completed', {
            jobId,
          });
        } else {
          logger.error('AI trigger job failed', {
            jobId,
            error: result.reason,
          });
        }
      });

      return results.map((result) =>
        result.status === 'fulfilled'
          ? result.value
          : {
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            }
      );
    }
  );

  logger.info('AI trigger worker registered', {
    queueName: QUEUE_NAMES.AI_SUGGESTION_TRIGGER,
  });
}
