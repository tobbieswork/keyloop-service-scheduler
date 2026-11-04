/* eslint-disable no-console -- this is a command-line script, not the service */
import { pathToFileURL } from 'node:url';
import { Migrator } from 'kysely/migration';
import { loadConfig } from '../config.js';
import { createDb, type Db } from './index.js';
import { migrations } from './migrations/index.js';

export interface MigrationOutcome {
  applied: string[];
}

/** Apply every pending migration. Throws if any migration fails (nothing is half-applied per migration). */
export async function migrateToLatest(db: Db): Promise<MigrationOutcome> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    throw error instanceof Error ? error : new Error(`Migration failed: ${String(error)}`);
  }
  return {
    applied: (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl, { poolSize: 1 });
  try {
    const { applied } = await migrateToLatest(db);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } finally {
    await db.destroy();
  }
}

// Run only when executed directly (`npm run migrate`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
