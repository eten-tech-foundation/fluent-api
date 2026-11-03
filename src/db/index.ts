import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import env from '@/env';

import * as draftCommentsSchema from './draft-comments.schema';
import * as schema from './schema';

const client = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
});

export const db = drizzle(client, {
  schema: { ...schema, ...draftCommentsSchema },
});
