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
  const url = `${env.FLUENT_AI_URL}${env.FLUENT_AI_API_PREFIX}/suggestions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.FLUENT_AI_KEY,
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
