import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { createDb } from '../../src/db/index.js';

// Fastify announces options it will remove in its next major version through Node's warning
// channel. Starting the service should print none: a warning on every start is noise that hides
// real problems, and each one is an upgrade that would break later.
describe('starting the app', () => {
  it('raises no Fastify deprecation warnings', async () => {
    const warnings: { name: string; code?: string; message: string }[] = [];
    const listener = (w: { name: string; code?: string; message: string }) => warnings.push(w);
    process.on('warning', listener);
    // The pool connects lazily, so no database is needed just to build the app.
    const db = createDb('postgres://unused:unused@127.0.0.1:1/unused', { poolSize: 1 });
    try {
      const app = await buildApp({
        config: {
          nodeEnv: 'test',
          port: 0,
          logLevel: 'silent',
          databaseUrl: 'unused',
          otlpEndpoint: undefined,
        },
        db,
      });
      await app.ready();
      await new Promise((resolve) => setTimeout(resolve, 50)); // warnings are delivered asynchronously
      await app.close();
    } finally {
      process.off('warning', listener);
      await db.destroy();
    }
    const fastify = warnings.filter(
      (w) => w.name === 'FastifyDeprecation' || w.code?.startsWith('FSTDEP'),
    );
    expect(fastify.map((w) => `${w.code}: ${w.message}`)).toEqual([]);
  });
});
