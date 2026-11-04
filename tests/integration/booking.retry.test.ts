import { sql } from 'kysely';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/api/errors.js';
import { createMetrics, type Metrics } from '../../src/observability/metrics.js';
import { createAvailabilityService } from '../../src/services/availability.js';
import {
  CONTENTION_BUDGET_MS,
  createBookingService,
  MAX_ATTEMPTS,
  requestHash,
  type BookingRequest,
  type BookingService,
} from '../../src/services/booking.js';
import { tryLockBay, tryLockTechnician } from '../../src/db/repositories/resources.js';
import { NOW } from './helpers/api.js';
import { startTestDb, type TestDb } from './helpers/db.js';
import { createWorld, insertAppointment, type World } from './helpers/fixtures.js';

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

// Row locks held by a test must never outlive it: a left-over lock would make the next test's
// TRUNCATE wait forever. Every holder registers its release here.
const releasers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (releasers.length > 0) await releasers.pop()!();
});

const log = pino({ level: 'silent' });
const START = new Date('2030-03-04T09:00:00.000Z');
const request = (world: World, key: string): BookingRequest => ({
  customerId: world.customerId,
  vehicleId: world.vehicleId,
  serviceTypeId: world.serviceTypeId,
  dealershipId: world.dealershipId,
  startTime: START,
  idempotencyKey: key,
});

interface Harness {
  service: BookingService;
  metrics: Metrics;
  sleeps: number[];
  attempts: { attempt: number; bayId: string; technicianId: string }[];
}

/** A booking service with the test seams: no real waiting, and a hook just before each insert. */
function harness(options: {
  onBeforeInsert?: (info: {
    attempt: number;
    bayId: string;
    technicianId: string;
  }) => Promise<void>;
  afterIdempotencyCheck?: (attempt: number) => Promise<void>;
  afterCandidatesRead?: (info: {
    attempt: number;
    bayIds: string[];
    technicianIds: string[];
  }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Harness {
  const metrics = createMetrics();
  let fakeNowMs = 0; // time only passes when the service sleeps, so tests never really wait
  const sleeps: number[] = [];
  const attempts: Harness['attempts'] = [];
  const clock = () => NOW;
  const service = createBookingService({
    db: testDb.db,
    metrics,
    clock,
    availability: createAvailabilityService({ db: testDb.db, metrics, clock }),
    now: () => fakeNowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      fakeNowMs += ms;
      await options.sleep?.(ms);
    },
    random: () => 0,
    testHooks: {
      afterIdempotencyCheck: async (attempt) => {
        await options.afterIdempotencyCheck?.(attempt);
      },
      afterCandidatesRead: async (info) => {
        await options.afterCandidatesRead?.(info);
      },
      beforeInsert: async (info) => {
        attempts.push({
          attempt: info.attempt,
          bayId: info.bayId,
          technicianId: info.technicianId,
        });
        await options.onBeforeInsert?.(info);
      },
    },
  });
  return { service, metrics, sleeps, attempts };
}

const retries = async (m: Metrics) => {
  const hit = /^scheduler_booking_retries_total (\d+)$/m.exec(await m.registry.metrics());
  return hit ? Number(hit[1]) : 0;
};
const confirmedCount = async () => {
  const { rows } = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM appointment WHERE status = 'confirmed'`.execute(testDb.db);
  return Number(rows[0]?.n);
};
/** Another booking sneaks in on exactly the resources we chose, after our checks and before our insert. */
const stealResources = (world: World, info: { bayId: string; technicianId: string }, key: string) =>
  insertAppointment(testDb.db, world, {
    bayId: info.bayId,
    technicianId: info.technicianId,
    start: START.toISOString(),
    end: new Date(START.getTime() + 60 * 60_000).toISOString(),
    key,
  });

describe('the database constraint as the final safety net (23P01)', () => {
  it('recomputes the choice after a rejected insert and books the OTHER resources', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    const h = harness({
      onBeforeInsert: async (info) => {
        if (info.attempt === 1) await stealResources(world, info, 'stolen-1');
      },
    });

    const outcome = await h.service.book(request(world, 'retry-key-1'), log);

    expect(outcome.replayed).toBe(false);
    expect(h.attempts).toHaveLength(2);
    expect(h.attempts[1]!.bayId).not.toBe(h.attempts[0]!.bayId); // the choice was recomputed
    expect(h.attempts[1]!.technicianId).not.toBe(h.attempts[0]!.technicianId);
    expect(await retries(h.metrics)).toBe(1);
    expect(await confirmedCount()).toBe(2); // the stolen one plus ours, never the same resources twice
  });

  it('stops retrying once nothing is free: a recomputed "full" is a plain 409, not another retry', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const h = harness({
      onBeforeInsert: async (info) => {
        if (info.attempt === 1) await stealResources(world, info, 'stolen-1');
      },
    });
    await expect(h.service.book(request(world, 'retry-key-2'), log)).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
    expect(h.attempts).toHaveLength(1); // the second attempt saw nothing free and gave up at once
    expect(await confirmedCount()).toBe(1);
  });

  it(`never makes more than ${MAX_ATTEMPTS} attempts, even if every attempt is rejected`, async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 6, technicians: 6 });
    const h = harness({
      onBeforeInsert: async (info) => {
        await stealResources(world, info, `stolen-${info.attempt}`);
      },
    });

    const error = await h.service.book(request(world, 'retry-key-3'), log).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('SLOT_UNAVAILABLE');
    expect(h.attempts).toHaveLength(MAX_ATTEMPTS);
    expect(await retries(h.metrics)).toBe(MAX_ATTEMPTS - 1);
    expect(h.sleeps).toHaveLength(MAX_ATTEMPTS - 1); // it paused between attempts, not after the last
    expect(await confirmedCount()).toBe(MAX_ATTEMPTS); // only the three stolen ones; ours was never stored
  });
});

describe('a request that keeps losing races still gets a place while capacity remains', () => {
  // The candidate list was read, then someone else booked exactly the resources we were about to
  // take. That is not a database rejection, it is a stale view: retry with a fresh list.
  it('survives more stale-view losses than the constraint bound (the false-409 fix)', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 6, technicians: 6 });
    const stolen: string[] = [];
    const h = harness({
      afterCandidatesRead: async ({ attempt, bayIds, technicianIds }) => {
        if (attempt > 4) return; // lose four times in a row (more than MAX_ATTEMPTS = 3)
        await stealResources(
          world,
          { bayId: bayIds[0]!, technicianId: technicianIds[0]! },
          `stale-${attempt}`,
        );
        stolen.push(bayIds[0]!);
      },
    });

    const outcome = await h.service.book(request(world, 'stale-key-1'), log);

    expect(outcome.replayed).toBe(false);
    expect(stolen).toHaveLength(4);
    expect(stolen).not.toContain(outcome.appointment.bayId); // got one of the two places left
    expect(await retries(h.metrics)).toBe(4);
    expect(await confirmedCount()).toBe(5); // four taken by others, one ours
  });

  it('is still told "no capacity" straight away once nothing is left', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const h = harness({
      afterCandidatesRead: async ({ attempt, bayIds, technicianIds }) => {
        if (attempt === 1) {
          await stealResources(
            world,
            { bayId: bayIds[0]!, technicianId: technicianIds[0]! },
            'last-place',
          );
        }
      },
    });

    await expect(h.service.book(request(world, 'stale-key-2'), log)).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
    expect(h.sleeps).toHaveLength(1); // one pause, then the fresh list showed nothing free: no waiting out the budget
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(CONTENTION_BUDGET_MS);
  });
});

describe('the same idempotency key arriving at the worst moment', () => {
  it('replays instead of a false 409 when the key is committed between the key check and the capacity check', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const req = request(world, 'racing-key-1');
    let winnerId: string | undefined;

    const h = harness({
      // Our request has just found no earlier booking for this key. Before it looks for free
      // resources, an identical request with the same key finishes, taking the only bay and technician.
      afterIdempotencyCheck: async (attempt) => {
        if (attempt !== 1) return;
        const winner = await insertAppointment(testDb.db, world, {
          bayId: world.bayIds[0]!,
          technicianId: world.technicianIds[0]!,
          start: START.toISOString(),
          end: new Date(START.getTime() + 60 * 60_000).toISOString(),
          key: req.idempotencyKey,
          requestHash: requestHash(req),
        });
        winnerId = winner.id;
      },
    });

    const outcome = await h.service.book(req, log);

    expect(outcome.replayed).toBe(true);
    expect(outcome.appointment.id).toBe(winnerId);
    expect(await confirmedCount()).toBe(1);
  });

  it('still rejects the same key when the body differs, even in that race', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const req = request(world, 'racing-key-2');
    const h = harness({
      afterIdempotencyCheck: async (attempt) => {
        if (attempt !== 1) return;
        await insertAppointment(testDb.db, world, {
          bayId: world.bayIds[0]!,
          technicianId: world.technicianIds[0]!,
          start: START.toISOString(),
          end: new Date(START.getTime() + 60 * 60_000).toISOString(),
          key: req.idempotencyKey,
          requestHash: 'a-different-request',
        });
      },
    });
    await expect(h.service.book(req, log)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });
});

describe('the locks a booking takes', () => {
  it('do not block other inserts that reference the same bay and technician (foreign-key checks)', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    // Hold the booking's locks, then insert an appointment for the same resources from a second
    // connection. A stricter lock (FOR UPDATE) makes that insert wait, so a short lock timeout turns
    // a would-be deadlock into a clear failure.
    await testDb.db.transaction().execute(async (holder) => {
      await tryLockBay(holder, world.bayIds[0]!);
      await tryLockTechnician(holder, world.technicianIds[0]!);
      await testDb.db.transaction().execute(async (other) => {
        await sql`SET LOCAL lock_timeout = '2s'`.execute(other);
        await insertAppointment(other, world, {
          bayId: world.bayIds[0]!,
          technicianId: world.technicianIds[0]!,
          start: START.toISOString(),
          end: new Date(START.getTime() + 60 * 60_000).toISOString(),
          key: 'fk-check-key',
        });
      });
    });
    expect(await confirmedCount()).toBe(1);
  });

  it('still exclude each other: a second booking cannot take a resource that is locked', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await testDb.db.transaction().execute(async (holder) => {
      expect(await tryLockBay(holder, world.bayIds[0]!)).toBe(true);
      await testDb.db.transaction().execute(async (other) => {
        expect(await tryLockBay(other, world.bayIds[0]!)).toBe(false); // skipped, never waited
      });
    });
  });
});

describe('contention: free resources momentarily held by other in-flight bookings', () => {
  /** Hold row locks on a bay and technician, as another booking in flight would. */
  async function holdLocks(world: World) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedPromise = new Promise<void>((r) => (locked = r));
    const holder = testDb.db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM service_bay WHERE id = ${world.bayIds[0]!} FOR NO KEY UPDATE`.execute(
        trx,
      );
      await sql`SELECT id FROM technician WHERE id = ${world.technicianIds[0]!} FOR NO KEY UPDATE`.execute(
        trx,
      );
      locked();
      await released;
    });
    await lockedPromise;
    let done = false;
    const releaseOnce = async () => {
      if (done) return;
      done = true;
      release();
      await holder;
    };
    releasers.push(releaseOnce);
    return { release: releaseOnce };
  }

  it('keeps retrying while resources stay held, and gives a 409 only when the time budget runs out', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const lock = await holdLocks(world);
    const h = harness({});

    await expect(h.service.book(request(world, 'held-key-1'), log)).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
    await lock.release();

    // Far more than the 3 constraint retries, and it stopped because the budget was spent.
    expect(h.sleeps.length).toBeGreaterThan(MAX_ATTEMPTS);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(CONTENTION_BUDGET_MS);
    expect(await retries(h.metrics)).toBe(h.sleeps.length);
    expect(await confirmedCount()).toBe(0);
  });

  it('succeeds on a later attempt once the resources are released', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const lock = await holdLocks(world);
    const h = harness({ sleep: () => lock.release() }); // the other booking finishes during our first pause

    const outcome = await h.service.book(request(world, 'held-key-2'), log);

    expect(outcome.replayed).toBe(false);
    expect(h.sleeps).toHaveLength(1);
    expect(await retries(h.metrics)).toBe(1);
    expect(await confirmedCount()).toBe(1);
  });

  it('does NOT queue behind a held resource when another free one exists (no waiting, no deadlock)', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    const lock = await holdLocks(world); // holds only the first bay and technician
    const h = harness({});

    const outcome = await h.service.book(request(world, 'held-key-3'), log);
    await lock.release();

    expect(outcome.replayed).toBe(false);
    expect(h.sleeps).toHaveLength(0); // first attempt succeeded on the unlocked pair
    expect(world.bayIds).toContain(outcome.appointment.bayId);
    expect(await retries(h.metrics)).toBe(0);
  });
});
