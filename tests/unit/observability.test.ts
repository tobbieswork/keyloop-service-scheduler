import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerErrorHandling } from '../../src/api/errors.js';
import { generateRequestId, observabilityServerOptions } from '../../src/observability/logger.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { registerObservability } from '../../src/observability/plugin.js';
import { withSpan } from '../../src/observability/tracing.js';

const SECRET_VIN = 'SECRET-VIN-1HGCM82633A004352';
const SECRET_NAME = 'SECRET-Customer-Jane-Doe';
const SECRET_TOKEN = 'Bearer secret-token-abc123';

interface Harness {
  app: FastifyInstance;
  lines: () => Record<string, unknown>[];
  raw: () => string;
}

function build(): Harness {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  const app = Fastify(observabilityServerOptions('info', stream));
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  registerObservability(app, createMetrics());

  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/things/:id', async () => ({ ok: true }));
  typed.post(
    '/people',
    { schema: { body: z.object({ name: z.string().max(3), vin: z.string().max(3) }) } },
    async () => ({ ok: true }),
  );
  app.get('/pg-error', async () => {
    // Shaped like a node-postgres unique violation: the `detail` carries the offending value.
    throw Object.assign(
      new Error('duplicate key value violates unique constraint "vehicle_vin_key"'),
      {
        code: '23505',
        constraint: 'vehicle_vin_key',
        table: 'vehicle',
        detail: `Key (vin)=(${SECRET_VIN}) already exists.`,
        parameters: [SECRET_NAME],
      },
    );
  });
  return {
    app,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    raw: () => chunks.join(''),
  };
}

describe('request IDs', () => {
  it('puts the same request ID on every log line of a request', async () => {
    const h = build();
    await h.app.inject({
      method: 'GET',
      url: '/things/1',
      headers: { 'x-request-id': 'client-id-42' },
    });
    const lines = h.lines();
    expect(lines.length).toBeGreaterThanOrEqual(2); // "incoming request" and "request completed"
    for (const line of lines) expect(line['reqId']).toBe('client-id-42');
  });

  it('generates a UUID when the caller sends none, and a different one per request', async () => {
    const h = build();
    const a = await h.app.inject({ method: 'GET', url: '/things/1' });
    const b = await h.app.inject({ method: 'GET', url: '/things/1' });
    const idA = a.headers['x-request-id'] as string;
    const idB = b.headers['x-request-id'] as string;
    expect(idA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idA).not.toBe(idB);
  });

  it('echoes the request ID in the x-request-id response header', async () => {
    const h = build();
    const res = await h.app.inject({
      method: 'GET',
      url: '/things/1',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('uses the same ID in the error body and the logs', async () => {
    const h = build();
    const res = await h.app.inject({
      method: 'GET',
      url: '/pg-error',
      headers: { 'x-request-id': 'trace-me' },
    });
    expect(res.json().error.requestId).toBe('trace-me');
    expect(h.lines().every((l) => l['reqId'] === 'trace-me')).toBe(true);
  });

  describe('generateRequestId', () => {
    it.each([
      ['a plain ID', 'req-1', 'req-1'],
      ['dots, underscores and dashes', 'a.b_c-9', 'a.b_c-9'],
      ['64 characters (the maximum)', 'x'.repeat(64), 'x'.repeat(64)],
    ])('keeps %s', (_name, header, expected) => {
      expect(generateRequestId({ headers: { 'x-request-id': header } })).toBe(expected);
    });

    it.each([
      ['too long', 'x'.repeat(65)],
      ['contains a newline (log injection)', 'abc\n{"level":60,"msg":"forged"}'],
      ['contains spaces', 'has space'],
      ['contains quotes', 'a"b'],
      ['is empty', ''],
    ])('replaces an ID that %s', (_name, header) => {
      const id = generateRequestId({ headers: { 'x-request-id': header } });
      expect(id).not.toBe(header);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('uses only the first value when the header is repeated', () => {
      expect(generateRequestId({ headers: { 'x-request-id': ['first', 'second'] } })).toBe('first');
    });
  });
});

describe('logs never contain personal data (FR-014)', () => {
  it('does not log the request body, even when validation fails', async () => {
    const h = build();
    const res = await h.app.inject({
      method: 'POST',
      url: '/people',
      payload: { name: SECRET_NAME, vin: SECRET_VIN },
    });
    expect(res.statusCode).toBe(400);
    expect(h.raw()).not.toContain(SECRET_NAME);
    expect(h.raw()).not.toContain(SECRET_VIN);
  });

  it('does not log request headers such as Authorization', async () => {
    const h = build();
    await h.app.inject({
      method: 'GET',
      url: '/things/1',
      headers: { authorization: SECRET_TOKEN },
    });
    expect(h.raw()).not.toContain('secret-token-abc123');
  });

  it('does not log the query string', async () => {
    const h = build();
    await h.app.inject({ method: 'GET', url: `/things/1?vin=${SECRET_VIN}` });
    expect(h.raw()).not.toContain(SECRET_VIN);
    expect(JSON.stringify(h.lines())).toContain('/things/1'); // the path itself is still logged
  });

  it('strips database error detail and parameters (they carry the offending values)', async () => {
    const h = build();
    const res = await h.app.inject({ method: 'GET', url: '/pg-error' });
    expect(res.statusCode).toBe(500);
    expect(h.raw()).not.toContain(SECRET_VIN);
    expect(h.raw()).not.toContain(SECRET_NAME);
  });

  it('still logs what is needed to debug a database error: message, code, constraint, stack', async () => {
    const h = build();
    await h.app.inject({ method: 'GET', url: '/pg-error' });
    const errLine = h.lines().find((l) => l['err'] !== undefined);
    expect(errLine).toBeDefined();
    const err = errLine?.['err'] as Record<string, unknown>;
    expect(err['message']).toContain('vehicle_vin_key');
    expect(err['code']).toBe('23505');
    expect(err['constraint']).toBe('vehicle_vin_key');
    expect(String(err['stack'])).toContain('Error');
  });
});

describe('metrics', () => {
  const body = async (h: Harness) => (await h.app.inject({ method: 'GET', url: '/metrics' })).body;

  it('exposes Prometheus text', async () => {
    const h = build();
    const res = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# TYPE scheduler_http_request_duration_seconds histogram');
  });

  it('labels requests by route pattern, not by the raw URL (no unbounded labels, no IDs)', async () => {
    const h = build();
    await h.app.inject({ method: 'GET', url: '/things/secret-id-111' });
    await h.app.inject({ method: 'GET', url: '/things/secret-id-222' });
    const text = await body(h);
    expect(text).toContain('route="/things/:id"');
    expect(text).not.toContain('secret-id-111');
    expect(text).not.toContain('secret-id-222');
  });

  it('counts requests per status code', async () => {
    const h = build();
    await h.app.inject({ method: 'GET', url: '/things/1' });
    await h.app.inject({ method: 'GET', url: '/pg-error' });
    const text = await body(h);
    expect(text).toMatch(
      /scheduler_http_request_duration_seconds_count\{[^}]*route="\/things\/:id"[^}]*status_code="200"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /scheduler_http_request_duration_seconds_count\{[^}]*route="\/pg-error"[^}]*status_code="500"[^}]*\} 1/,
    );
  });

  it('groups unknown URLs under one label so scanners cannot create endless series', async () => {
    const h = build();
    await h.app.inject({ method: 'GET', url: '/wp-admin/xyz' });
    await h.app.inject({ method: 'GET', url: '/another/random/path' });
    const text = await body(h);
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('wp-admin');
  });

  it('shows booking outcome and retry counters at zero before any booking', async () => {
    const h = build();
    const text = await body(h);
    for (const result of ['confirmed', 'conflict', 'invalid']) {
      expect(text).toContain(`scheduler_booking_outcomes_total{result="${result}"} 0`);
    }
    expect(text).toContain('scheduler_booking_retries_total 0');
  });

  it('has duration histograms for bookings and availability queries', async () => {
    const text = await body(build());
    expect(text).toContain('# TYPE scheduler_booking_duration_seconds histogram');
    expect(text).toContain('# TYPE scheduler_availability_duration_seconds histogram');
  });

  it("keeps each app instance's counters separate (no shared global state)", async () => {
    const a = build();
    const b = build();
    await a.app.inject({ method: 'GET', url: '/things/1' });
    expect(await body(a)).toContain('route="/things/:id"');
    expect(await body(b)).not.toContain('route="/things/:id"');
  });
});

describe('tracing: withSpan', () => {
  const exporter = new InMemorySpanExporter();
  beforeAll(() => {
    // NodeSDK registers this in the real server; a bare test provider needs it for parent-child spans.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(
      new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
    );
  });
  afterAll(() => {
    trace.disable();
    context.disable();
  });

  it('records a finished span with the given name and attributes', async () => {
    exporter.reset();
    const result = await withSpan('booking.transaction', async () => 42, {
      'dealership.id': 'd-1',
    });
    expect(result).toBe(42);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('booking.transaction');
    expect(span?.attributes['dealership.id']).toBe('d-1');
    expect(span?.status.code).toBe(0); // UNSET: not an error
  });

  it('marks the span as an error, records the exception and rethrows', async () => {
    exporter.reset();
    await expect(
      withSpan('availability.query', async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2); // ERROR
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('nests: a span started inside another becomes its child', async () => {
    exporter.reset();
    await withSpan('outer', async () => withSpan('inner', async () => 1));
    const spans = exporter.getFinishedSpans();
    const outer = spans.find((s) => s.name === 'outer');
    const inner = spans.find((s) => s.name === 'inner');
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
  });
});
