import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import type { Writable } from 'node:stream';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { observabilityServerOptions } from '../observability/logger.js';
import { createMetrics, type Metrics } from '../observability/metrics.js';
import { registerObservability } from '../observability/plugin.js';
import { createAvailabilityService } from '../services/availability.js';
import { createBookingService } from '../services/booking.js';
import { createCancelService } from '../services/cancel.js';
import { createUnavailabilityService } from '../services/unavailability.js';
import { acceptEmptyJsonBodies } from './empty-body.js';
import { registerErrorHandling } from './errors.js';
import { registerAppointmentRoutes } from './routes/appointments.js';
import { registerAvailabilityRoutes } from './routes/availability.js';
import { registerUnavailabilityRoutes } from './routes/unavailability.js';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Defaults to a fresh set, so each app instance counts separately. */
  metrics?: Metrics;
  /** Where logs go. Defaults to stdout; tests pass a stream to capture them. */
  logStream?: Writable;
  /** Current time. Defaults to the real clock; tests inject a fixed one. */
  clock?: () => Date;
  /** How to check the database for /ready. Defaults to `SELECT 1`. */
  readinessCheck?: () => Promise<void>;
  /** /ready gives up after this long. Default 2000 ms. */
  readinessTimeoutMs?: number;
}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Readiness check timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the HTTP app. Pure wiring: it does not open ports, read the environment or start
 * tracing, so tests can build as many independent instances as they like.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const metrics = deps.metrics ?? createMetrics();
  const readinessCheck =
    deps.readinessCheck ??
    (async () => {
      await sql`SELECT 1`.execute(db);
    });

  const app = Fastify(observabilityServerOptions(config.logLevel, deps.logStream));
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  acceptEmptyJsonBodies(app);

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Unified Service Scheduler API', version: '0.1.0' },
    },
    transform: jsonSchemaTransform,
  });

  registerObservability(app, metrics);

  // Liveness: the process is up. Deliberately does not touch the database, because restarting
  // the service would not fix a database outage.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: the service can do useful work, so the database must answer.
  app.get('/ready', async (request, reply) => {
    try {
      await withTimeout(readinessCheck(), deps.readinessTimeoutMs ?? 2000);
      return { status: 'ready' };
    } catch (error) {
      request.log.warn({ err: error }, 'Readiness check failed');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  const clock = deps.clock ?? (() => new Date());
  const availability = createAvailabilityService({ db, metrics, clock });
  const booking = createBookingService({ db, metrics, clock, availability });
  registerAppointmentRoutes(app, { db, booking, cancel: createCancelService({ db, clock }) });
  registerAvailabilityRoutes(app, { db, availability });
  registerUnavailabilityRoutes(app, { unavailability: createUnavailabilityService({ db }) });

  return app;
}
