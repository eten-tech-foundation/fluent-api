import type { PgBoss } from 'pg-boss';

import type { USFMExportJob } from '@/lib/queue';

import * as usfmService from '@/domains/usfm/usfm.service';
import { uploadExportStream } from '@/lib/blob-storage';
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

    let filename: string;
    let sizeBytes: number;
    let expiresAt: Date;
    try {
      // Streamed straight into blob storage — the archive is never buffered
      // in memory, so export size does not affect worker memory.
      ({ filename, sizeBytes, expiresAt } = await uploadExportStream(job.id, stream, {
        requestedby: String(requestedBy ?? ''),
        projectunitid: String(projectUnitId),
      }));
    } finally {
      cleanup();
    }

    const projectNameResult = await usfmService.getProjectName(projectUnitId);
    const projectName = projectNameResult.ok ? projectNameResult.data : null;
    const displayFilename = projectName
      ? `${projectName.trim().replace(/[<>:"/\\|?*]/g, '_')}.zip`
      : filename;

    const duration = Date.now() - startTime;

    const result = {
      success: true,
      projectUnitId,
      bookIds,
      sizeBytes,
      durationMs: duration,
      downloadUrl: `/downloads/${filename}`,
      displayFilename,
      expiresAt: expiresAt.toISOString(),
    };

    logger.info('USFM export job completed', { jobId: job.id, result });

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
    batchSize: 1,
  });

  // batchSize 1 so each handler invocation maps to exactly one job: a thrown
  // error fails THAT job and pg-boss's retry/dead-letter machinery applies.
  // (The previous batch handler swallowed rejections via Promise.allSettled and
  // returned error objects, which marked failed jobs as completed.)
  await boss.work<USFMExportJob>(
    QUEUE_NAMES.USFM_EXPORT,
    {
      batchSize: 1,
      pollingIntervalSeconds: 2,
    },
    async (jobs: JobPayload[]) => {
      const job = jobs[0];
      hooks?.onBatchStart?.(1);
      const start = Date.now();

      try {
        const result = await processUSFMExportJob(job);
        hooks?.onJobSuccess?.(Date.now() - start);
        return result;
      } catch (error) {
        hooks?.onJobFailure?.(Date.now() - start);
        // Rethrow so pg-boss marks the job failed and schedules a retry
        // (or routes it to the dead-letter queue after retryLimit).
        throw error;
      } finally {
        hooks?.onBatchEnd?.(1);
      }
    }
  );

  logger.info('USFM export worker registered', {
    queueName: QUEUE_NAMES.USFM_EXPORT,
  });
}
