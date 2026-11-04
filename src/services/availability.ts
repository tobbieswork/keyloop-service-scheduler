import { AppError } from '../api/errors.js';
import type { Db } from '../db/index.js';
import { loadDayResources } from '../db/repositories/availability.js';
import { getDealership, getServiceType } from '../db/repositories/reference.js';
import { generateSlots, type Slot } from '../domain/slot-generation.js';
import { localDayBounds } from '../domain/working-hours.js';
import type { Metrics } from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';

export interface AvailabilityQuery {
  dealershipId: string;
  serviceTypeId: string;
  /** The dealership-local calendar date, 'YYYY-MM-DD'. */
  date: string;
}

export interface AvailabilityService {
  /** Every start time on that date at which a booking would currently succeed (FR-010). */
  slotsForDay(query: AvailabilityQuery): Promise<Slot[]>;
}

export interface AvailabilityDeps {
  db: Db;
  metrics: Metrics;
  clock: () => Date;
}

export function createAvailabilityService(deps: AvailabilityDeps): AvailabilityService {
  const { db, metrics, clock } = deps;

  return {
    async slotsForDay(query) {
      const stopTimer = metrics.availabilityDuration.startTimer();
      try {
        return await withSpan(
          'availability.query',
          async () => {
            const dealership = await getDealership(db, query.dealershipId);
            if (!dealership) throw new AppError('NOT_FOUND', 'No dealership exists with that ID');
            const serviceType = await getServiceType(db, query.serviceTypeId);
            if (!serviceType)
              throw new AppError('NOT_FOUND', 'No service type exists with that ID');

            const day = localDayBounds(query.date, dealership.timeZone);
            const { bays, technicians } = await loadDayResources(
              db,
              dealership.id,
              serviceType.requiredSkillId,
              day,
            );
            return generateSlots({
              date: query.date,
              timeZone: dealership.timeZone,
              hours: dealership.hours,
              durationMinutes: serviceType.durationMinutes,
              bufferMinutes: serviceType.bufferMinutes,
              bays,
              technicians,
              now: clock(),
            });
          },
          { 'dealership.id': query.dealershipId, 'service_type.id': query.serviceTypeId },
        );
      } finally {
        stopTimer();
      }
    },
  };
}
