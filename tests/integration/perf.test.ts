import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookingBody, newKey, startApi, type TestApi } from './helpers/api.js';
import { startTestDb, type TestDb } from './helpers/db.js';
import { createWorld, type World } from './helpers/fixtures.js';

// Targets from specs/001-service-scheduler/plan.md (Technical Context), at 50 concurrent requests
// on a laptop-class machine with the database in a local container. They support SC-002, which
// promises an answer in under one second. This is a smoke test, not a benchmark: it catches a
// slow query or an accidental serial bottleneck, not small regressions.
const BOOKING_P95_MS = 300;
const AVAILABILITY_P95_MS = 200;
const CONCURRENCY = 50;

let testDb: TestDb;
let api: TestApi;
let world: World;

beforeAll(async () => {
  testDb = await startTestDb();
  api = await startApi(testDb);
  // Plenty of capacity, so every request succeeds and the test measures speed, not contention.
  world = await createWorld(testDb.db, { withHours: true, bays: 12, technicians: 12 });
});
afterAll(async () => {
  await api.app.close();
  await testDb.stop();
});

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
};

/** Run `count` requests at once and return how long each took, in milliseconds. */
async function timed<T extends { statusCode: number }>(
  count: number,
  make: (i: number) => Promise<T>,
  expectedStatus: number,
): Promise<number[]> {
  const durations = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const t0 = performance.now();
      const res = await make(i);
      expect(res.statusCode).toBe(expectedStatus);
      return performance.now() - t0;
    }),
  );
  return durations;
}

const report = (label: string, durations: number[]) =>
  process.stdout.write(
    `  ${label}: p50 ${percentile(durations, 0.5).toFixed(0)} ms, p95 ${percentile(durations, 0.95).toFixed(0)} ms, max ${Math.max(...durations).toFixed(0)} ms\n`,
  );

// Mondays and Tuesdays in March 2030, in winter time (London local time equals UTC).
const slot = (i: number) => {
  const day = i % 2 === 0 ? '04' : '05';
  const minutes = 8 * 60 + Math.floor(i / 2) * 15;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `2030-03-${day}T${hh}:${mm}:00.000Z`;
};

describe(`performance smoke test (${CONCURRENCY} concurrent requests)`, () => {
  it(`books with p95 under ${BOOKING_P95_MS} ms`, async () => {
    // Warm up: open connections and let the runtime compile the hot paths, as a running service would be.
    await timed(
      9,
      (i) =>
        api.book(
          bookingBody(world, `2030-03-06T${String(8 + i).padStart(2, '0')}:00:00.000Z`),
          newKey(),
        ),
      201,
    ); // 08:00 to 16:00 starts, the last one ending exactly at closing time

    const durations = await timed(
      CONCURRENCY,
      (i) => api.book(bookingBody(world, slot(i)), newKey()),
      201,
    );
    report('POST /appointments', durations);
    expect(percentile(durations, 0.95)).toBeLessThan(BOOKING_P95_MS);
  });

  it(`answers availability with p95 under ${AVAILABILITY_P95_MS} ms, with bookings already in place`, async () => {
    const query = {
      dealershipId: world.dealershipId,
      serviceTypeId: world.serviceTypeId,
      date: '2030-03-04',
    };
    await timed(10, () => api.availability(query), 200); // warm up

    const durations = await timed(CONCURRENCY, () => api.availability(query), 200);
    report('GET /availability', durations);
    expect(percentile(durations, 0.95)).toBeLessThan(AVAILABILITY_P95_MS);
  });

  it('still books and reads quickly when both happen at the same time', async () => {
    const query = {
      dealershipId: world.dealershipId,
      serviceTypeId: world.serviceTypeId,
      date: '2030-03-05',
    };
    const [bookings, reads] = await Promise.all([
      timed(
        25,
        (i) => {
          // 25 distinct start times on Thursday, 08:00 to 15:45, so every one fits before closing.
          const hour = 8 + (i % 8);
          const minute = Math.floor(i / 8) * 15;
          const start = `2030-03-07T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
          return api.book(bookingBody(world, start), newKey());
        },
        201,
      ),
      timed(25, () => api.availability(query), 200),
    ]);
    report('mixed: bookings', bookings);
    report('mixed: availability', reads);
    expect(percentile(bookings, 0.95)).toBeLessThan(BOOKING_P95_MS * 2);
    expect(percentile(reads, 0.95)).toBeLessThan(AVAILABILITY_P95_MS * 2);
  });
});
