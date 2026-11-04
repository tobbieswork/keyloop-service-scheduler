import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { createDb, type Db } from '../../../src/db/index.js';
import { migrateToLatest } from '../../../src/db/migrate.js';

export interface TestDb {
  db: Db;
  databaseUrl: string;
  /** Remove all rows from every application table (the migration history is kept). */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Start a throwaway real Postgres 16, apply all migrations, and return a typed connection.
 * Booking correctness depends on real Postgres behaviour (exclusion constraints, row locks),
 * so database mocks are deliberately not used.
 */
export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16',
  ).start();
  const databaseUrl = container.getConnectionUri();
  const db = createDb(databaseUrl, { poolSize: 30 }); // headroom for concurrency tests
  await migrateToLatest(db);

  return {
    db,
    databaseUrl,
    reset: async () => {
      const { rows } = await sql<{ tablename: string }>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE 'kysely_%'
      `.execute(db);
      if (rows.length === 0) return;
      const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
      await sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`).execute(db);
    },
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}
