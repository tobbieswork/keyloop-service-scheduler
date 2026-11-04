import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Writable } from 'node:stream';
import { buildApp } from '../../../src/api/app.js';
import type { Config } from '../../../src/config.js';
import type { Db } from '../../../src/db/index.js';
import type { TestDb } from './db.js';
import type { World } from './fixtures.js';

/** "Now" for tests. All test dates (March 2030) are after it, so bookings are in the future. */
export const NOW = new Date('2030-03-01T00:00:00.000Z');

export interface TestApi {
  app: FastifyInstance;
  /** Move the injected clock. */
  setNow: (now: Date) => void;
  book: (body: Record<string, unknown>, key?: string | null) => Promise<LightMyRequestResponse>;
  getAppointment: (id: string) => Promise<LightMyRequestResponse>;
  get: (url: string) => Promise<LightMyRequestResponse>;
  cancel: (id: string) => Promise<LightMyRequestResponse>;
  availability: (query: {
    dealershipId: string;
    serviceTypeId: string;
    date: string;
  }) => Promise<LightMyRequestResponse>;
}

const config = (databaseUrl: string, logLevel: Config['logLevel']): Config => ({
  nodeEnv: 'test',
  port: 0,
  logLevel,
  databaseUrl,
  otlpEndpoint: undefined,
});

let keyCounter = 0;
/** A fresh idempotency key that satisfies the 8-128 character rule. */
export const newKey = () => `test-key-${Date.now()}-${++keyCounter}`;

export async function startApi(
  testDb: TestDb,
  now: Date = NOW,
  options: { logStream?: Writable; db?: Db } = {},
): Promise<TestApi> {
  let current = now;
  const app = await buildApp({
    config: config(testDb.databaseUrl, options.logStream ? 'info' : 'silent'),
    db: options.db ?? testDb.db,
    clock: () => current,
    ...(options.logStream && { logStream: options.logStream }),
  });
  return {
    app,
    setNow: (d) => {
      current = d;
    },
    book: (body, key = newKey()) =>
      app.inject({
        method: 'POST',
        url: '/appointments',
        headers: key === null ? {} : { 'idempotency-key': key },
        payload: body,
      }),
    getAppointment: (id) => app.inject({ method: 'GET', url: `/appointments/${id}` }),
    get: (url) => app.inject({ method: 'GET', url }),
    cancel: (id) => app.inject({ method: 'POST', url: `/appointments/${id}/cancel` }),
    availability: (query) =>
      app.inject({
        method: 'GET',
        url: `/availability?${new URLSearchParams(query).toString()}`,
      }),
  };
}

/** A valid booking request body for a world, with optional field overrides. */
export const bookingBody = (
  world: World,
  startTime: string,
  overrides: Record<string, unknown> = {},
) => ({
  customerId: world.customerId,
  vehicleId: world.vehicleId,
  serviceTypeId: world.serviceTypeId,
  dealershipId: world.dealershipId,
  startTime,
  ...overrides,
});

/** Monday 2030-03-04 is in winter time, so London local time equals UTC. */
export const monday = (hhmm: string) => `2030-03-04T${hhmm}:00.000Z`;
