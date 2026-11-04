import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { Config } from '../../src/config.js';
import { createDb } from '../../src/db/index.js';
import { startTestDb, type TestDb } from './helpers/db.js';

const config = (databaseUrl: string): Config => ({
  nodeEnv: 'test',
  port: 0,
  logLevel: 'silent',
  databaseUrl,
  otlpEndpoint: undefined,
});

let testDb: TestDb;
beforeAll(async () => {
  testDb = await startTestDb();
});
afterAll(async () => {
  await testDb.stop();
});

describe('app skeleton', () => {
  it('GET /health reports the process is alive without touching the database', async () => {
    // A database that cannot be reached must not make liveness fail (a restart would not fix it).
    const deadDb = createDb('postgres://u:p@127.0.0.1:1/none', { poolSize: 1 });
    const app = await buildApp({ config: config(testDb.databaseUrl), db: deadDb });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
    await deadDb.destroy();
  });

  it('GET /ready is 200 when the database answers', async () => {
    const app = await buildApp({ config: config(testDb.databaseUrl), db: testDb.db });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('GET /ready is 503 when the database is unreachable, without leaking connection details', async () => {
    const deadDb = createDb('postgres://secretuser:secretpw@127.0.0.1:1/none', { poolSize: 1 });
    const app = await buildApp({ config: config(testDb.databaseUrl), db: deadDb });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    expect(res.body).not.toContain('secretpw');
    expect(res.body).not.toContain('127.0.0.1');
    await app.close();
    await deadDb.destroy();
  });

  it('GET /ready gives up quickly when the database hangs instead of waiting forever', async () => {
    // A database that accepts the call but never answers: the check must time out, not hang.
    const app = await buildApp({
      config: config(testDb.databaseUrl),
      db: testDb.db,
      readinessTimeoutMs: 50,
      readinessCheck: () => new Promise<void>(() => {}), // never settles
    });
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(1000);
    await app.close();
  });

  it('GET /metrics works and counts the requests made', async () => {
    const app = await buildApp({ config: config(testDb.databaseUrl), db: testDb.db });
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('route="/health"');
    await app.close();
  });

  it('returns the standard error shape and a request ID for unknown routes', async () => {
    const app = await buildApp({ config: config(testDb.databaseUrl), db: testDb.db });
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'it-1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'it-1' },
    });
    expect(res.headers['x-request-id']).toBe('it-1');
    await app.close();
  });

  it('builds an OpenAPI 3 document from its routes', async () => {
    const app = await buildApp({ config: config(testDb.databaseUrl), db: testDb.db });
    await app.ready();
    const doc = app.swagger() as { openapi: string; info: { title: string } };
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('Unified Service Scheduler API');
    await app.close();
  });

  it('can be built many times in one process (no shared global state)', async () => {
    const apps = await Promise.all(
      Array.from({ length: 3 }, () =>
        buildApp({ config: config(testDb.databaseUrl), db: testDb.db }),
      ),
    );
    for (const app of apps) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      await app.close();
    }
  });
});
