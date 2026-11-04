import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  bookingOutcomes: Counter<'result'>;
  bookingRetries: Counter;
  bookingDuration: Histogram;
  availabilityDuration: Histogram;
}

export type BookingResult = 'confirmed' | 'conflict' | 'invalid';
const BOOKING_RESULTS: BookingResult[] = ['confirmed', 'conflict', 'invalid'];

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

/**
 * Create a fresh set of metrics with its own registry, so test apps do not share counters.
 * Pass `processMetrics: true` in the real server to add CPU, memory and event-loop metrics.
 */
export function createMetrics(options: { processMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (options.processMetrics) collectDefaultMetrics({ register: registry, prefix: 'scheduler_' });

  const bookingOutcomes = new Counter({
    name: 'scheduler_booking_outcomes_total',
    help: 'Booking requests by outcome: confirmed, conflict (no capacity) or invalid (rejected input).',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  // Start every outcome at 0 so dashboards show a flat line instead of a missing series.
  for (const result of BOOKING_RESULTS) bookingOutcomes.inc({ result }, 0);

  return {
    registry,
    // `route` is the route pattern (for example /appointments/:id), never the raw URL.
    httpDuration: new Histogram({
      name: 'scheduler_http_request_duration_seconds',
      help: 'HTTP request duration by method, route pattern and status code.',
      labelNames: ['method', 'route', 'status_code'] as const,
      buckets: SECONDS,
      registers: [registry],
    }),
    bookingOutcomes,
    bookingRetries: new Counter({
      name: 'scheduler_booking_retries_total',
      help: 'Booking attempts repeated after a database exclusion-constraint conflict.',
      registers: [registry],
    }),
    bookingDuration: new Histogram({
      name: 'scheduler_booking_duration_seconds',
      help: 'Time spent in the booking transaction.',
      buckets: SECONDS,
      registers: [registry],
    }),
    availabilityDuration: new Histogram({
      name: 'scheduler_availability_duration_seconds',
      help: 'Time spent computing availability.',
      buckets: SECONDS,
      registers: [registry],
    }),
  };
}
