import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env['DATABASE_URL'];

if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('DATABASE_URL environment variable is not set.');
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
});
