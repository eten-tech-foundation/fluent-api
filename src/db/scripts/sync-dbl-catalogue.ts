import { syncBiblesFromDbl } from '@/domains/bibles/sync/dbl-bible-sync';
import { syncBooksFromDbl } from '@/domains/books/sync/dbl-book-sync';
import { syncLanguagesFromDbl } from '@/domains/languages/sync/dbl-language-sync';
import { logger } from '@/lib/logger';

async function main() {
  logger.info('Starting manual DBL catalogue sync...');

  logger.info('Step 1/3: Syncing languages from DBL...');
  const langResult = await syncLanguagesFromDbl();
  if (!langResult.ok) {
    logger.error('Language sync failed', { error: langResult.error });
    process.exit(1);
  }
  logger.info('Languages sync completed', { data: langResult.data });

  logger.info('Step 2/3: Syncing bibles from DBL...');
  const biblesResult = await syncBiblesFromDbl();
  if (!biblesResult.ok) {
    logger.error('Bibles sync failed', { error: biblesResult.error });
    process.exit(1);
  }
  logger.info('Bibles sync completed', { data: biblesResult.data });

  logger.info('Step 3/3: Syncing books from DBL...');
  const booksResult = await syncBooksFromDbl();
  if (!booksResult.ok) {
    logger.error('Books sync failed', { error: booksResult.error });
    process.exit(1);
  }
  logger.info('Books sync completed', { data: booksResult.data });

  logger.info('DBL catalogue sync completed successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error during DBL sync:', err);
  process.exit(1);
});
