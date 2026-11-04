import { z } from 'zod';

/** Thrown when the environment is invalid. The message names variables, never their values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: string;
  /** When unset, trace spans are printed to the console instead of exported. */
  otlpEndpoint: string | undefined;
}

// An empty string (e.g. a blank line in .env) counts as "not set".
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

const schema = z.object({
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  DATABASE_URL: z
    .string({ error: 'is required' })
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
});

/**
 * Validate the environment once at startup and fail fast with every problem listed.
 * Error messages contain only variable names and rules, so secrets such as a database
 * password can never end up in logs.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || 'environment';
      return `${name}: ${issue.message}`;
    });
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  const e = result.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}
