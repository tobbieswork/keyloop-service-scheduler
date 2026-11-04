import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  ERROR_STATUS,
  registerErrorHandling,
  type ErrorCode,
} from '../../src/api/errors.js';

// Independent copy of the status table in specs/001-service-scheduler/research.md (decision 8).
const TABLE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  SLOT_UNAVAILABLE: 409,
  RESOURCE_HAS_APPOINTMENTS: 409,
  OUTSIDE_WORKING_HOURS: 422,
  START_IN_PAST: 422,
  VEHICLE_CUSTOMER_MISMATCH: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  INTERNAL_ERROR: 500,
};

const SECRET_INTERNAL = 'connection to 10.0.0.5 refused, password=hunter2';

function buildApp(logLines?: string[]): FastifyInstance {
  const stream = new Writable({
    write(chunk, _enc, done) {
      logLines?.push(String(chunk));
      done();
    },
  });
  const app = Fastify({
    genReqId: () => 'req-test-1',
    logger: logLines ? { level: 'error', stream } : false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/echo',
    {
      schema: {
        headers: z.object({ 'idempotency-key': z.string().min(8) }),
        body: z.object({ vehicleId: z.uuid(), count: z.number().int() }),
      },
    },
    async () => ({ ok: true }),
  );
  typed.get(
    '/bad-response',
    { schema: { response: { 200: z.object({ id: z.string() }) } } },
    // Deliberately returns the wrong shape, as a programming mistake would.
    async () => ({ id: 5 }) as unknown as { id: string },
  );
  app.get('/boom', async () => {
    throw new Error(SECRET_INTERNAL);
  });
  app.get<{ Params: { code: ErrorCode } }>('/app-error/:code', async (req) => {
    throw new AppError(req.params.code, `message for ${req.params.code}`);
  });
  app.get('/with-details', async () => {
    throw new AppError('OUTSIDE_WORKING_HOURS', 'Closed', { details: { reason: 'CLOSED_DAY' } });
  });
  app.get('/conflict', async () => {
    throw new AppError('SLOT_UNAVAILABLE', 'No capacity at that time', {
      extra: {
        alternatives: [
          { startTime: '2030-03-04T10:00:00.000Z', endTime: '2030-03-04T11:00:00.000Z' },
        ],
      },
    });
  });
  return app;
}

const validEcho = {
  method: 'POST' as const,
  url: '/echo',
  headers: { 'idempotency-key': 'key-12345678' },
  payload: { vehicleId: '11111111-1111-4111-8111-111111111111', count: 1 },
};

describe('status table', () => {
  it('matches the documented table exactly', () => {
    expect(ERROR_STATUS).toEqual(TABLE);
  });
});

describe('AppError through the handler', () => {
  it.each(Object.entries(TABLE))('%s returns HTTP %i', async (code, status) => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/app-error/${code}` });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({
      error: { code, message: `message for ${code}`, requestId: 'req-test-1' },
    });
  });

  it('includes details only when provided', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/with-details' });
    expect(res.json().error.details).toEqual({ reason: 'CLOSED_DAY' });
    const plain = await app.inject({ method: 'GET', url: '/app-error/NOT_FOUND' });
    expect(plain.json().error).not.toHaveProperty('details');
  });

  it('puts extra fields beside "error", as the conflict contract expects', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/conflict' });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('SLOT_UNAVAILABLE');
    expect(body.alternatives).toHaveLength(1);
    expect(body.error).not.toHaveProperty('alternatives');
  });
});

describe('request validation maps to 400 VALIDATION_ERROR', () => {
  it('accepts a valid request', async () => {
    const res = await buildApp().inject(validEcho);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a malformed field and names the field', async () => {
    const res = await buildApp().inject({
      ...validEcho,
      payload: { vehicleId: 'not-a-uuid', count: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.requestId).toBe('req-test-1');
    expect(JSON.stringify(body.error.details)).toContain('vehicleId');
  });

  it('never echoes the submitted value back (it may be personal data)', async () => {
    const secret = 'SECRET-VIN-1HGCM82633A004352';
    const res = await buildApp().inject({ ...validEcho, payload: { vehicleId: secret, count: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(secret);
  });

  it('rejects a missing or too-short Idempotency-Key header and names it', async () => {
    const missing = await buildApp().inject({ ...validEcho, headers: {} });
    expect(missing.statusCode).toBe(400);
    expect(JSON.stringify(missing.json().error.details)).toContain('idempotency-key');

    const short = await buildApp().inject({ ...validEcho, headers: { 'idempotency-key': 'abc' } });
    expect(short.statusCode).toBe(400);
  });

  it('reports several problems at once', async () => {
    const res = await buildApp().inject({ ...validEcho, payload: { vehicleId: 'x', count: 1.5 } });
    const details = JSON.stringify(res.json().error.details);
    expect(details).toContain('vehicleId');
    expect(details).toContain('count');
  });

  it('rejects malformed JSON', async () => {
    const res = await buildApp().inject({
      ...validEcho,
      headers: { ...validEcho.headers, 'content-type': 'application/json' },
      payload: '{"vehicleId": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  // End-to-end guarantee: whatever the framework does, a malformed body is never quoted back.
  // (Fastify 5 does not quote it today, so this guards against a future version changing that.)
  it('does not quote a malformed body back to the caller', async () => {
    const secret = 'SECRET-VIN-1HGCM82633A004352';
    const res = await buildApp().inject({
      ...validEcho,
      headers: { ...validEcho.headers, 'content-type': 'application/json' },
      payload: `{"vehicleId": "${secret}", oops`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(secret);
  });

  it('turns other client errors (such as a wrong content type) into 400 VALIDATION_ERROR', async () => {
    const res = await buildApp().inject({
      ...validEcho,
      headers: { ...validEcho.headers, 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('unknown routes', () => {
  it('return 404 NOT_FOUND in the standard error shape', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'req-test-1' },
    });
  });
});

describe('unexpected errors', () => {
  it('return a generic 500 and never leak the internal message', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'req-test-1' },
    });
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('10.0.0.5');
  });

  it('are logged with the request ID so they can be traced, not swallowed', async () => {
    const lines: string[] = [];
    await buildApp(lines).inject({ method: 'GET', url: '/boom' });
    const logged = lines.map((l) => JSON.parse(l));
    expect(logged.some((l) => l.reqId === 'req-test-1' && l.level >= 50)).toBe(true);
  });

  it("are what a response that breaks its own schema becomes (a programming error, not the caller's)", async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/bad-response' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });
});
