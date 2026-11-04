import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { AppError } from '../api/errors.js';
import type { Db } from '../db/index.js';
import {
  hasConfirmedAppointment,
  insertBlock,
  lockResource,
  type ResourceKind,
  type UnavailabilityRecord,
} from '../db/repositories/unavailability.js';
import { range } from '../domain/time-range.js';

export interface BlockRequest {
  start: Date;
  end: Date;
  reason: string;
}

export interface UnavailabilityService {
  /**
   * Mark a bay or technician unavailable for a time range (FR-015). Refused when the range would
   * overlap a confirmed appointment of that resource (an appointment is never silently cancelled)
   * or an existing block of that resource.
   */
  block(
    kind: ResourceKind,
    resourceId: string,
    request: BlockRequest,
    log: FastifyBaseLogger,
  ): Promise<UnavailabilityRecord>;
}

const PG_EXCLUSION_VIOLATION = '23P01';

export function createUnavailabilityService(deps: { db: Db }): UnavailabilityService {
  const { db } = deps;

  return {
    async block(kind, resourceId, request, log) {
      if (!(request.end.getTime() > request.start.getTime())) {
        throw new AppError('VALIDATION_ERROR', 'The end of the period must be after its start');
      }
      const period = range(request.start, request.end);

      try {
        const record = await db.transaction().execute(async (trx) => {
          await sql`SET LOCAL lock_timeout = '3s'`.execute(trx);

          // Take the resource's lock first. If a booking is in flight on it we wait for that
          // booking to finish, so the check below sees its appointment; if we hold it first, a
          // booking cannot take the resource until we are done, and it re-checks blocks under its
          // own lock before inserting. Either order ends with no overlap (SC-006).
          if (!(await lockResource(trx, kind, resourceId))) {
            throw new AppError('NOT_FOUND', `No ${kind} exists with that ID`);
          }
          if (await hasConfirmedAppointment(trx, kind, resourceId, period)) {
            throw new AppError(
              'RESOURCE_HAS_APPOINTMENTS',
              `That ${kind} has a confirmed appointment in the period; cancel it first`,
            );
          }
          return insertBlock(trx, kind, resourceId, period, request.reason);
        });
        log.info({ outcome: 'blocked', kind, resourceId, blockId: record.id }, 'Resource blocked');
        return record;
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === PG_EXCLUSION_VIOLATION
        ) {
          throw new AppError(
            'UNAVAILABILITY_OVERLAP',
            `That ${kind} is already marked unavailable for part of that period`,
          );
        }
        throw error;
      }
    },
  };
}
