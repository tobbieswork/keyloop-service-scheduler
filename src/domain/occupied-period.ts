import { range, type TimeRange } from './time-range.js';

export interface OccupiedPeriod {
  /** The time the bay and technician are blocked: start up to the end of the buffer (half-open). */
  occupied: TimeRange;
  /** When the work itself ends, without the buffer. Shown to customers. */
  serviceEnd: Date;
}

const MINUTE = 60_000;

/**
 * The time a booking blocks: the service duration plus that service type's own buffer
 * (FR-002). The buffer may be zero. Durations are whole minutes.
 */
export function occupiedPeriod(
  start: Date,
  durationMinutes: number,
  bufferMinutes: number,
): OccupiedPeriod {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new RangeError('Service duration must be a positive whole number of minutes');
  }
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0) {
    throw new RangeError('Service buffer must be a whole number of minutes, zero or more');
  }
  const serviceEnd = new Date(start.getTime() + durationMinutes * MINUTE);
  const occupiedEnd = new Date(serviceEnd.getTime() + bufferMinutes * MINUTE);
  return { occupied: range(start, occupiedEnd), serviceEnd };
}
