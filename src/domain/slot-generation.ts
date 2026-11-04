import { overlaps, range, type TimeRange } from './time-range.js';
import {
  localDateTime,
  openingWindow,
  SLOT_MINUTES,
  type HoursByWeekday,
} from './working-hours.js';

/** A bay or technician and the time it is already committed. */
export interface Resource {
  id: string;
  /** Periods this resource cannot take new work: confirmed appointments (and blocks, later). */
  busy: readonly TimeRange[];
}

export interface SlotRequest {
  /** The dealership-local calendar date, 'YYYY-MM-DD'. */
  date: string;
  timeZone: string;
  hours: HoursByWeekday;
  durationMinutes: number;
  bufferMinutes: number;
  bays: readonly Resource[];
  /** Only technicians qualified for the service type. */
  technicians: readonly Resource[];
  now: Date;
}

export interface Slot {
  startTime: Date;
  /** End of the occupied period: the service duration plus the buffer. */
  endTime: Date;
}

const MINUTE = 60_000;

/** True when at least one resource is free for the whole period (not merely for parts of it). */
const anyFreeFor = (resources: readonly Resource[], period: TimeRange): boolean =>
  resources.some((r) => r.busy.every((b) => !overlaps(b, period)));

/**
 * Every start time on the given local date at which a booking would succeed: on the 15-minute
 * grid, in the future, with the whole occupied period inside working hours, and with ONE bay and
 * ONE qualified technician each free for the whole period. This uses the same rules as booking,
 * so availability never offers a slot that booking would refuse, or hides one it would accept.
 */
export function generateSlots(request: SlotRequest): Slot[] {
  const window = openingWindow(request.date, request.timeZone, request.hours);
  if (!window) return []; // closed that day
  if (request.bays.length === 0 || request.technicians.length === 0) return [];

  const occupiedMs = (request.durationMinutes + request.bufferMinutes) * MINUTE;

  // First start on or after opening that sits on a 15-minute boundary of the local clock.
  const openMs = Math.ceil(window.start.getTime() / MINUTE) * MINUTE;
  const remainder = localDateTime(new Date(openMs), request.timeZone).minutesOfDay % SLOT_MINUTES;
  const firstMs = openMs + ((SLOT_MINUTES - remainder) % SLOT_MINUTES) * MINUTE;

  const slots: Slot[] = [];
  for (
    let startMs = firstMs;
    startMs + occupiedMs <= window.end.getTime();
    startMs += SLOT_MINUTES * MINUTE
  ) {
    if (startMs <= request.now.getTime()) continue; // a booking must be strictly in the future
    const period = range(new Date(startMs), new Date(startMs + occupiedMs));
    if (anyFreeFor(request.bays, period) && anyFreeFor(request.technicians, period)) {
      slots.push({ startTime: period.start, endTime: period.end });
    }
  }
  return slots;
}
