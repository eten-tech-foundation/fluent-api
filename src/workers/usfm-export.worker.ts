import type { PgBoss } from 'pg-boss';

import { Buffer } from 'node:buffer';

import type { USFMExportJob } from '@/lib/queue';

import * as usfmService from '@/domains/usfm/usfm.service';
import { saveExportFile } from '@/lib/file-storage';
import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';

interface JobPayload {
  id: string;
  data: USFMExportJob;
}

export interface WorkerMetricsHooks {
  onBatchStart?: (count: number) => void;
  onBatchEnd?: (count: number) => void;
  onJobSuccess?: (durationMs: number) => void;
  onJobFailure?: (durationMs: number) => void;
}

export async function processUSFMExportJob(job: JobPayload): Promise<any> {
  const startTime = Date.now();
  const { projectUnitId, bookIds, requestedBy } = job.data;

  logger.info('Starting USFM export job', {
    jobId: job.id,
    projectUnitId,
    bookIds,
    requestedBy,
  });

  try {
    const exportResultObj = await usfmService.createUSFMZipStreamAsync(projectUnitId, bookIds);

    if (!exportResultObj.ok || !exportResultObj.data) {
      throw new Error('No books available for export');
    }

    const { stream, cleanup } = exportResultObj.data;

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    const zipBuffer = Buffer.concat(chunks);
    const totalSize = zipBuffer.length;

    cleanup();

    const { filename, expiresAt } = await saveExportFile(job.id, zipBuffer);

    const projectNameResult = await usfmService.getProjectName(projectUnitId);
    const projectName = projectNameResult.ok ? projectNameResult.data : null;
    const displayFilename = projectName
      ? `${projectName.trim().replace(/[<>:"/\\|?*]/g, '_')}.zip`
      : filename;

    const duration = Date.now() - startTime;

    logger.info('USFM export job completed', {
      jobId: job.id,
      projectUnitId,
      bookIds,
      sizeBytes: totalSize,
      durationMs: duration,
      filename,
    });

    const result = {
      success: true,
      projectUnitId,
      bookIds,
      sizeBytes: totalSize,
      durationMs: duration,
      downloadUrl: `/downloads/${filename}`,
      displayFilename,
      expiresAt: expiresAt.toISOString(),
    };

    logger.info('USFM export job result', { jobId: job.id, result });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const duration = Date.now() - startTime;

    logger.error('USFM export job failed', {
      jobId: job.id,
      projectUnitId,
      bookIds,
      error: errorMessage,
      durationMs: duration,
      stack: error instanceof Error ? error.stack : undefined,
    });

    throw new Error(`USFM export failed: ${errorMessage}`);
  }
}

export async function registerUSFMExportWorker(
  boss: PgBoss,
  hooks?: WorkerMetricsHooks
): Promise<void> {
  logger.info('Registering USFM export worker', {
    queueName: QUEUE_NAMES.USFM_EXPORT,
    batchSize: 5,
  });

  await boss.work<USFMExportJob>(
    QUEUE_NAMES.USFM_EXPORT,
    {
      batchSize: 5,
      pollingIntervalSeconds: 2,
    },
    async (jobs: JobPayload[]) => {
      logger.info('Worker received jobs', { count: jobs.length });

      hooks?.onBatchStart?.(jobs.length);

      const results = await Promise.allSettled(
        jobs.map(async (job) => {
          const start = Date.now();
          try {
            const value = await processUSFMExportJob(job);
            const duration = Date.now() - start;
            hooks?.onJobSuccess?.(duration);
            return value;
          } catch (error) {
            const duration = Date.now() - start;
            hooks?.onJobFailure?.(duration);
            throw error;
          }
        })
      );

      hooks?.onBatchEnd?.(jobs.length);

      results.forEach((result, index) => {
        const jobId = jobs[index].id;
        if (result.status === 'fulfilled') {
          logger.info('USFM job completed', {
            jobId,
            output: result.value,
          });
        } else {
          logger.error('USFM job failed', {
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

  logger.info('USFM export worker registered', {
    queueName: QUEUE_NAMES.USFM_EXPORT,
  });
}
