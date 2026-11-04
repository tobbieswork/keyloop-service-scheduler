import type { Migration } from 'kysely/migration';
import { migration001 } from './001_init.js';

/**
 * Migrations are registered here in order (keys sort lexically, so keep the numeric prefix).
 * A static registry, rather than reading the folder at runtime, works the same under tsx,
 * Vitest and the compiled build.
 */
export const migrations: Record<string, Migration> = {
  '001_init': migration001,
};
