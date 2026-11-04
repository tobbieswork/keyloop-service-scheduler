import { sql } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/api/errors.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { createAvailabilityService } from '../../src/services/availability.js';
import {
  createBookingService,
  type BookingRequest,
  type BookingTestHooks,
} from '../../src/services/booking.js';
import { createUnavailabilityService } from '../../src/services/unavailability.js';
import {
  blockBody,
  bookingBody,
  monday,
  newKey,
  NOW,
  startApi,
  type TestApi,
} from './helpers/api.js';
import { startTestDb, type TestDb } from './helpers/db.js';
import { createWorld, type World } from './helpers/fixtures.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await startTestDb();
});
afterAll(async () => {
  await testDb.stop();
});
beforeEach(async () => {
  await testDb.reset();
});

const log = pino({ level: 'silent' });
const START = new Date('2030-03-04T09:00:00.000Z');
const range = (from: string, to: string) => ({
  start: new Date(`2030-03-04T${from}:00.000Z`),
  end: new Date(`2030-03-04T${to}:00.000Z`),
  reason: 'SAMPLE maintenance',
});
const request = (world: World, key: string): BookingRequest => ({
  customerId: world.customerId,
  vehicleId: world.vehicleId,
  serviceTypeId: world.serviceTypeId,
  dealershipId: world.dealershipId,
  startTime: START,
  idempotencyKey: key,
});

function services(testHooks: BookingTestHooks) {
  const metrics = createMetrics();
  const clock = () => NOW;
  let fakeNow = 0;
  const booking = createBookingService({
    db: testDb.db,
    metrics,
    clock,
    availability: createAvailabilityService({ db: testDb.db, metrics, clock }),
    now: () => fakeNow,
    sleep: async (ms) => {
      fakeNow += ms;
    },
    random: () => 0,
    testHooks,
  });
  const unavailability = createUnavailabilityService({ db: testDb.db, clock });
  return { booking, unavailability };
}

const confirmed = async () => {
  const { rows } = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM appointment WHERE status = 'confirmed'`.execute(testDb.db);
  return Number(rows[0]?.n);
};
/** Any confirmed appointment sharing time with a block on its own bay or technician (must be none, SC-006). */
const overlapsWithBlocks = async () => {
  const { rows } = await sql<{ n: string }>`
    SELECT ((SELECT count(*) FROM appointment a JOIN bay_unavailability u
                ON u.bay_id = a.bay_id AND u.period && a.occupied_period WHERE a.status = 'confirmed')
          + (SELECT count(*) FROM appointment a JOIN technician_unavailability u
                ON u.technician_id = a.technician_id AND u.period && a.occupied_period WHERE a.status = 'confirmed'))::text AS n`.execute(
    testDb.db,
  );
  return Number(rows[0]?.n);
};

describe('booking and blocking the same resource at the same moment (SC-006, FR-015)', () => {
  // Each ordering is forced with a hook, so the outcome never depends on luck.

  it.each(['bay', 'technician'] as const)(
    'a %s blocked AFTER the candidates were read but BEFORE the locks is still respected (re-check under the lock)',
    async (kind) => {
      const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
      const ids = { bay: world.bayIds[0]!, technician: world.technicianIds[0]! };
      let unavailabilityService!: ReturnType<typeof createUnavailabilityService>;
      const s = services({
        afterCandidatesRead: async ({ attempt }) => {
          if (attempt === 1)
            await unavailabilityService.block(kind, ids[kind], range('09:00', '12:00'), log);
        },
      });
      unavailabilityService = s.unavailability;

      const error = await s.booking.book(request(world, newKey()), log).catch((e: unknown) => e);

      // The booking read a list that still showed the resource free; the block committed; the
      // booking took the lock, saw the block on its re-check, and refused to insert.
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('SLOT_UNAVAILABLE');
      expect(await confirmed()).toBe(0);
      expect(await overlapsWithBlocks()).toBe(0);
    },
  );

  it.each(['bay', 'technician'] as const)(
    'a %s block that arrives while a booking holds the locks waits, then is refused because the appointment now exists',
    async (kind) => {
      const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
      const ids = { bay: world.bayIds[0]!, technician: world.technicianIds[0]! };
      let blockResult: Promise<unknown> | undefined;
      let unavailabilityService!: ReturnType<typeof createUnavailabilityService>;
      const s = services({
        beforeInsert: async () => {
          // The booking holds its locks right now. Start the block WITHOUT awaiting it (it must wait),
          // then wait until Postgres confirms it is genuinely blocked on a lock.
          blockResult = unavailabilityService
            .block(kind, ids[kind], range('09:00', '12:00'), log)
            .catch((e: unknown) => e);
          for (let i = 0; i < 100; i++) {
            const { rows } = await sql<{ n: string }>`
              SELECT count(*)::text AS n FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`.execute(
              testDb.db,
            );
            if (Number(rows[0]?.n) > 0) return;
            await new Promise((r) => setTimeout(r, 20));
          }
          throw new Error('the block never started waiting on the booking lock');
        },
      });
      unavailabilityService = s.unavailability;

      const outcome = await s.booking.book(request(world, newKey()), log);
      const blockError = await blockResult;

      expect(outcome.replayed).toBe(false);
      expect(blockError).toBeInstanceOf(AppError);
      expect((blockError as AppError).code).toBe('RESOURCE_HAS_APPOINTMENTS');
      expect(await confirmed()).toBe(1);
      expect(await overlapsWithBlocks()).toBe(0);
    },
  );

  it('does not interfere when they concern different times', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const s = services({});
    await s.unavailability.block('bay', world.bayIds[0]!, range('13:00', '15:00'), log);
    const outcome = await s.booking.book(request(world, newKey()), log); // 09:00-10:00
    expect(outcome.replayed).toBe(false);
  });
});

describe('many bookings and blocks at once never leave an overlap', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startApi(testDb);
  });
  afterAll(async () => {
    await api.app.close();
  });

  it.each([1, 2, 3, 4, 5])(
    'round %i: 20 bookings racing 4 blocks on the same resources',
    async () => {
      await testDb.reset();
      const world = await createWorld(testDb.db, { withHours: true, bays: 3, technicians: 3 });

      const bookings = Array.from({ length: 20 }, () =>
        api.book(bookingBody(world, monday('09:00')), newKey()),
      );
      const blocks = [
        api.block('bay', world.bayIds[0]!, blockBody('09:00', '12:00')),
        api.block('bay', world.bayIds[1]!, blockBody('09:00', '12:00')),
        api.block('technician', world.technicianIds[0]!, blockBody('09:00', '12:00')),
        api.block('technician', world.technicianIds[2]!, blockBody('08:00', '11:00')),
      ];
      const responses = await Promise.all([...bookings, ...blocks]);

      // Every response is a clean success or a business conflict, never a server error.
      expect(responses.every((r) => [200, 201, 409].includes(r.statusCode))).toBe(true);
      // The invariant: no confirmed appointment shares time with a block on its own bay or technician.
      expect(await overlapsWithBlocks()).toBe(0);
      // No double-booking either.
      const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM appointment a JOIN appointment b
        ON a.id < b.id AND a.status = 'confirmed' AND b.status = 'confirmed'
       AND (a.bay_id = b.bay_id OR a.technician_id = b.technician_id)
       AND a.occupied_period && b.occupied_period`.execute(testDb.db);
      expect(Number(rows[0]?.n)).toBe(0);
    },
  );
});
