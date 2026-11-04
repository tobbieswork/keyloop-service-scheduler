import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { AppError } from '../api/errors.js';
import type { Db } from '../db/index.js';
import {
  findAppointmentByIdempotencyKey,
  insertAppointment,
  type AppointmentRecord,
} from '../db/repositories/appointments.js';
import {
  customerExists,
  getDealership,
  getServiceType,
  getVehicle,
} from '../db/repositories/reference.js';
import {
  freeBays,
  freeTechnicians,
  stillFree,
  tryLockBay,
  tryLockTechnician,
} from '../db/repositories/resources.js';
import { occupiedPeriod } from '../domain/occupied-period.js';
import { qualifiedTechnicians, rankByLeastBooked } from '../domain/resource-selection.js';
import { checkWorkingHours, localDateTime, localDayBounds } from '../domain/working-hours.js';
import type { TimeRange } from '../domain/time-range.js';
import type { Metrics } from '../observability/metrics.js';
import type { AvailabilityService } from './availability.js';
import { withSpan } from '../observability/tracing.js';

export interface BookingRequest {
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  dealershipId: string;
  startTime: Date;
  idempotencyKey: string;
}

export interface BookingOutcome {
  appointment: AppointmentRecord;
  /** True when this is the stored result of an earlier request with the same idempotency key. */
  replayed: boolean;
}

/**
 * Test seams. Real code never sets these. They let a test pause a booking at an exact point, so
 * rare races (another request landing between two steps) can be reproduced on purpose instead
 * of hoped for.
 */
export interface BookingTestHooks {
  /** Runs inside the transaction right after the idempotency-key check. */
  afterIdempotencyCheck?: (attempt: number) => Promise<void>;
  /** Runs inside the transaction after the locks and re-check, just before the insert. */
  beforeInsert?: (info: {
    attempt: number;
    bayId: string;
    technicianId: string;
    occupied: TimeRange;
  }) => Promise<void>;
}

export interface BookingServiceDeps {
  db: Db;
  metrics: Metrics;
  clock: () => Date;
  /** Used to offer alternative slots when a request is rejected for lack of capacity. */
  availability: AvailabilityService;
  testHooks?: BookingTestHooks;
  /** Wait between attempts. Injectable so tests need not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Randomness for the wait between attempts. Injectable for tests. */
  random?: () => number;
}

export interface BookingService {
  book(request: BookingRequest, log: FastifyBaseLogger): Promise<BookingOutcome>;
}

/** A booking is tried at most this many times when other bookings hold the same resources. */
export const MAX_ATTEMPTS = 3;

/** Stable fingerprint of what the caller asked for, to tell a retry from a different request. */
export function requestHash(r: BookingRequest): string {
  // The start is normalised to an instant, so the same moment written with different offsets matches.
  return createHash('sha256')
    .update(
      JSON.stringify([
        r.customerId,
        r.vehicleId,
        r.serviceTypeId,
        r.dealershipId,
        r.startTime.toISOString(),
      ]),
    )
    .digest('hex');
}

type Attempt =
  | { kind: 'booked'; appointment: AppointmentRecord }
  | { kind: 'existing'; appointment: AppointmentRecord } // another request with this key won
  | { kind: 'full' } //      no free qualified bay or technician at all
  | { kind: 'contended' }; // free ones exist, but other in-flight bookings hold them

const PG_EXCLUSION_VIOLATION = '23P01';
const PG_UNIQUE_VIOLATION = '23505';

const pgCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
const pgConstraint = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'constraint' in error
    ? String((error as { constraint: unknown }).constraint)
    : undefined;

const notFound = (what: string) => new AppError('NOT_FOUND', `No ${what} exists with that ID`);

export function createBookingService(deps: BookingServiceDeps): BookingService {
  const { db, metrics, clock } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  /** Return the stored result of an earlier request with the same key, if it was the same request. */
  function replay(existing: AppointmentRecord, hash: string): BookingOutcome {
    if (existing.requestHash !== hash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request',
      );
    }
    return { appointment: existing, replayed: true };
  }

  async function run(request: BookingRequest, log: FastifyBaseLogger): Promise<BookingOutcome> {
    const hash = requestHash(request);

    // 1. A repeated request returns the original result, whatever the state of the world now.
    const earlier = await findAppointmentByIdempotencyKey(db, request.idempotencyKey);
    if (earlier) return replay(earlier, hash);

    // 2. The things the request points at must exist and belong together.
    const dealership = await getDealership(db, request.dealershipId);
    if (!dealership) throw notFound('dealership');
    const serviceType = await getServiceType(db, request.serviceTypeId);
    if (!serviceType) throw notFound('service type');
    if (!(await customerExists(db, request.customerId))) throw notFound('customer');
    const vehicle = await getVehicle(db, request.vehicleId);
    if (!vehicle) throw notFound('vehicle');
    if (vehicle.customerId !== request.customerId) {
      throw new AppError(
        'VEHICLE_CUSTOMER_MISMATCH',
        'That vehicle does not belong to that customer',
      );
    }

    // 3. Business rules on time: not in the past, and inside working hours (FR-011).
    if (request.startTime.getTime() <= clock().getTime()) {
      throw new AppError('START_IN_PAST', 'The start time must be in the future');
    }
    const { occupied, serviceEnd } = occupiedPeriod(
      request.startTime,
      serviceType.durationMinutes,
      serviceType.bufferMinutes,
    );
    const hoursCheck = checkWorkingHours(occupied, dealership.timeZone, dealership.hours);
    if (!hoursCheck.ok) {
      const why = {
        NOT_ALIGNED: 'The start time must be on a 15-minute boundary of the dealership clock',
        CLOSED_DAY: 'The dealership is closed that day',
        OUTSIDE_HOURS: 'The appointment must fit inside the dealership working hours',
      }[hoursCheck.reason];
      throw new AppError('OUTSIDE_WORKING_HOURS', why, { details: { reason: hoursCheck.reason } });
    }

    // "Least booked that day" is counted on the dealership's local calendar day.
    const requestedDate = localDateTime(request.startTime, dealership.timeZone).date;
    const day = localDayBounds(requestedDate, dealership.timeZone);

    /** One transaction: choose, lock, re-check, insert. Rolls back completely on any failure. */
    const attempt = (attemptNumber: number): Promise<Attempt> =>
      db.transaction().execute(async (trx): Promise<Attempt> => {
        await sql`SET LOCAL statement_timeout = 5000`.execute(trx);

        // Another request with this key may have committed while we were waiting or retrying.
        const raced = await findAppointmentByIdempotencyKey(trx, request.idempotencyKey);
        if (raced) return { kind: 'existing', appointment: raced };
        await deps.testHooks?.afterIdempotencyCheck?.(attemptNumber);

        const bays = rankByLeastBooked(await freeBays(trx, dealership.id, occupied, day));
        const technicians = rankByLeastBooked(
          qualifiedTechnicians(
            await freeTechnicians(trx, dealership.id, occupied, day),
            serviceType.requiredSkillId,
          ),
        );
        if (bays.length === 0 || technicians.length === 0) return { kind: 'full' };

        // Take the best candidate that is not already locked by another booking in flight. Never
        // waiting for a lock means two bookings can never wait on each other (no deadlock), and
        // concurrent bookings spread across free resources instead of queueing on one.
        let bayId: string | undefined;
        for (const bay of bays) {
          if (await tryLockBay(trx, bay.id)) {
            bayId = bay.id;
            break;
          }
        }
        let technicianId: string | undefined;
        for (const technician of technicians) {
          if (await tryLockTechnician(trx, technician.id)) {
            technicianId = technician.id;
            break;
          }
        }
        if (!bayId || !technicianId) return { kind: 'contended' };

        // The lists above were read before the locks, so check again now that we hold them.
        if (!(await stillFree(trx, bayId, technicianId, occupied))) return { kind: 'contended' };

        await deps.testHooks?.beforeInsert?.({
          attempt: attemptNumber,
          bayId,
          technicianId,
          occupied,
        });

        const appointment = await insertAppointment(trx, {
          customerId: request.customerId,
          vehicleId: request.vehicleId,
          serviceTypeId: serviceType.id,
          dealershipId: dealership.id,
          bayId,
          technicianId,
          occupied,
          serviceEnd,
          idempotencyKey: request.idempotencyKey,
          requestHash: hash,
        });
        return { kind: 'booked', appointment };
      });

    for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber++) {
      let result: Attempt;
      try {
        result = await attempt(attemptNumber);
      } catch (error) {
        if (pgCode(error) === PG_EXCLUSION_VIOLATION) {
          // The database refused an overlap our checks missed. It is the final safety net.
          result = { kind: 'contended' };
        } else if (
          pgCode(error) === PG_UNIQUE_VIOLATION &&
          pgConstraint(error) === 'appointment_idempotency_key_key'
        ) {
          const winner = await findAppointmentByIdempotencyKey(db, request.idempotencyKey);
          if (!winner) throw error;
          result = { kind: 'existing', appointment: winner };
        } else {
          throw error;
        }
      }

      if (result.kind === 'booked') return { appointment: result.appointment, replayed: false };
      if (result.kind === 'existing') return replay(result.appointment, hash);
      if (result.kind === 'full') break;

      if (attemptNumber < MAX_ATTEMPTS) {
        metrics.bookingRetries.inc();
        log.debug({ attempt: attemptNumber }, 'Booking attempt contended, retrying');
        await sleep(5 + random() * 20); // a short random pause so contenders do not collide again
      }
    }

    // About to say "no capacity". First make sure the capacity was not taken by THIS very request:
    // a copy sent at the same moment may have committed between our key check and our capacity
    // check, which would make this a replay, not a conflict.
    const winner = await findAppointmentByIdempotencyKey(db, request.idempotencyKey);
    if (winner) return replay(winner, hash);

    // Help the caller choose again. Failing to find alternatives must not hide the conflict itself.
    const alternatives = await deps.availability
      .alternatives({
        dealershipId: request.dealershipId,
        serviceTypeId: request.serviceTypeId,
        date: requestedDate,
      })
      .catch((error: unknown) => {
        log.warn({ err: error }, 'Could not compute alternative slots');
        return [];
      });
    throw new AppError(
      'SLOT_UNAVAILABLE',
      'No service bay and qualified technician are both free for the requested time',
      {
        extra: {
          alternatives: alternatives.map((s) => ({
            startTime: s.startTime.toISOString(),
            endTime: s.endTime.toISOString(),
          })),
        },
      },
    );
  }

  return {
    async book(request, log) {
      const stopTimer = metrics.bookingDuration.startTimer();
      try {
        const outcome = await withSpan('booking.transaction', () => run(request, log), {
          'dealership.id': request.dealershipId,
          'service_type.id': request.serviceTypeId,
        });
        const a = outcome.appointment;
        if (outcome.replayed) {
          log.info({ outcome: 'replayed', appointmentId: a.id }, 'Booking request replayed');
        } else {
          metrics.bookingOutcomes.inc({ result: 'confirmed' });
          // IDs only: names, VINs and contact details are never logged (FR-014).
          log.info(
            {
              outcome: 'confirmed',
              appointmentId: a.id,
              dealershipId: a.dealershipId,
              serviceTypeId: a.serviceTypeId,
              bayId: a.bayId,
              technicianId: a.technicianId,
            },
            'Booking confirmed',
          );
        }
        return outcome;
      } catch (error) {
        if (error instanceof AppError) {
          const result = error.code === 'SLOT_UNAVAILABLE' ? 'conflict' : 'invalid';
          metrics.bookingOutcomes.inc({ result });
          log.info({ outcome: result, code: error.code }, 'Booking rejected');
        }
        throw error;
      } finally {
        stopTimer();
      }
    },
  };
}
