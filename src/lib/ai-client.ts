import env from '@/env';
import { logger } from '@/lib/logger';

interface AiSuggestionTriggerRequest {
  projectUnitId: number;
  bibleId: number;
  bookCode: string;
  chapterNumber: number;
  verseStart: number;
  verseEnd: number;
}

export async function triggerAiSuggestions(jobs: AiSuggestionTriggerRequest[]): Promise<void> {
  const url = `${env.AI_SERVICE_BASE_URL}/suggestions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.AI_SERVICE_API_KEY,
      },
      body: JSON.stringify(jobs),
    });

    if (!response.ok) {
      throw new Error(`AI Service returned ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to call AI service trigger endpoint',
      context: { url, jobCount: jobs.length },
    });
    throw error;
  }
}
