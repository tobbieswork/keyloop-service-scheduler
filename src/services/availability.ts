import { AppError } from '../api/errors.js';
import type { Db } from '../db/index.js';
import { loadDayResources } from '../db/repositories/availability.js';
import { getDealership, getServiceType } from '../db/repositories/reference.js';
import { generateSlots, type Slot } from '../domain/slot-generation.js';
import { addDays, localDayBounds } from '../domain/working-hours.js';
import type { Metrics } from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';

export interface AvailabilityQuery {
  dealershipId: string;
  serviceTypeId: string;
  /** The dealership-local calendar date, 'YYYY-MM-DD'. */
  date: string;
}

/** On a capacity conflict, offer at most this many alternative slots... */
export const ALTERNATIVES_LIMIT = 5;
/** ...looking at the requested day and then this many days after it. */
export const ALTERNATIVES_DAYS = 7;

export interface AvailabilityService {
  /** Every start time on that date at which a booking would currently succeed (FR-010). */
  slotsForDay(query: AvailabilityQuery): Promise<Slot[]>;
  /**
   * Up to ALTERNATIVES_LIMIT bookable slots (FR-009): the given date first, then each of the next
   * ALTERNATIVES_DAYS days, earliest first. Uses exactly the rules of `slotsForDay`, so every
   * alternative can really be booked. Empty when nothing is free in that window.
   */
  alternatives(query: AvailabilityQuery): Promise<Slot[]>;
}

export interface AvailabilityDeps {
  db: Db;
  metrics: Metrics;
  clock: () => Date;
}

export function createAvailabilityService(deps: AvailabilityDeps): AvailabilityService {
  const { db, metrics, clock } = deps;

  async function context(query: Pick<AvailabilityQuery, 'dealershipId' | 'serviceTypeId'>) {
    const dealership = await getDealership(db, query.dealershipId);
    if (!dealership) throw new AppError('NOT_FOUND', 'No dealership exists with that ID');
    const serviceType = await getServiceType(db, query.serviceTypeId);
    if (!serviceType) throw new AppError('NOT_FOUND', 'No service type exists with that ID');
    return { dealership, serviceType };
  }

  async function slotsOn(ctx: Awaited<ReturnType<typeof context>>, date: string): Promise<Slot[]> {
    const { dealership, serviceType } = ctx;
    const day = localDayBounds(date, dealership.timeZone);
    const { bays, technicians } = await loadDayResources(
      db,
      dealership.id,
      serviceType.requiredSkillId,
      day,
    );
    return generateSlots({
      date,
      timeZone: dealership.timeZone,
      hours: dealership.hours,
      durationMinutes: serviceType.durationMinutes,
      bufferMinutes: serviceType.bufferMinutes,
      bays,
      technicians,
      now: clock(),
    });
  }

  return {
    async slotsForDay(query) {
      const stopTimer = metrics.availabilityDuration.startTimer();
      try {
        return await withSpan(
          'availability.query',
          async () => slotsOn(await context(query), query.date),
          { 'dealership.id': query.dealershipId, 'service_type.id': query.serviceTypeId },
        );
      } finally {
        stopTimer();
      }
    },

    async alternatives(query) {
      const stopTimer = metrics.availabilityDuration.startTimer();
      try {
        return await withSpan(
          'availability.alternatives',
          async () => {
            const ctx = await context(query);
            const found: Slot[] = [];
            for (
              let offset = 0;
              offset <= ALTERNATIVES_DAYS && found.length < ALTERNATIVES_LIMIT;
              offset++
            ) {
              const slots = await slotsOn(ctx, addDays(query.date, offset));
              found.push(...slots.slice(0, ALTERNATIVES_LIMIT - found.length));
            }
            return found;
          },
          { 'dealership.id': query.dealershipId, 'service_type.id': query.serviceTypeId },
        );
      } finally {
        stopTimer();
      }
    },
  };
}
