import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export type Db = Kysely<Database>;

export interface CreateDbOptions {
  /** Maximum pooled connections. */
  poolSize?: number;
}

/** Create a typed Kysely instance backed by a pg connection pool. Call `db.destroy()` on shutdown. */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.poolSize ?? 10,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export type { Database } from './types.js';
