import { contains, range, type TimeRange } from './time-range.js';

/** Appointments start on 15-minute boundaries of the dealership's local clock. */
export const SLOT_MINUTES = 15;

export interface DayHours {
  /** Local opening time, 'HH:MM' or 'HH:MM:SS'. */
  readonly open: string;
  readonly close: string;
}

/** Weekday 0 = Sunday ... 6 = Saturday. A missing day means the dealership is closed. */
export type HoursByWeekday = ReadonlyMap<number, DayHours>;

export interface LocalDateTime {
  /** Local calendar date, 'YYYY-MM-DD'. */
  date: string;
  minutesOfDay: number;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Building an Intl formatter is slow, and availability checks call this many times.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone, which is what we want.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(instant: Date, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts['year']!,
    month: parts['month']!,
    day: parts['day']!,
    hour: parts['hour']!,
    minute: parts['minute']!,
    second: parts['second']!,
  };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in minutes (DST-aware). */
function offsetMinutes(instantMs: number, timeZone: string): number {
  const w = wallClock(new Date(instantMs), timeZone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSeconds = Math.floor(instantMs / 1000) * 1000;
  return (wallAsUtc - wholeSeconds) / MINUTE;
}

function parseTime(time: string): { hours: number; minutes: number; seconds: number } {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!m) throw new RangeError(`Invalid time of day: ${time}`);
  return { hours: Number(m[1]), minutes: Number(m[2]), seconds: Number(m[3] ?? 0) };
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * Convert a local date and time in an IANA zone to the exact UTC moment.
 * Daylight-saving edge cases are handled deterministically:
 *  - a local time that happens twice (clocks go back) resolves to the EARLIER moment;
 *  - a local time that never happens (clocks go forward) moves FORWARD by the gap.
 */
export function zonedTimeToInstant(date: string, time: string, timeZone: string): Date {
  const { year, month, day } = parseDate(date);
  const { hours, minutes, seconds } = parseTime(time);
  const wallAsUtc = Date.UTC(year, month - 1, day, hours, minutes, seconds);

  // Offsets a day either side bracket any single daylight-saving change.
  const before = offsetMinutes(wallAsUtc - DAY, timeZone);
  const after = offsetMinutes(wallAsUtc + DAY, timeZone);

  const consistent = [before, after]
    .map((offset) => wallAsUtc - offset * MINUTE)
    .filter((candidate) => offsetMinutes(candidate, timeZone) * MINUTE === wallAsUtc - candidate);

  if (consistent.length === 0) {
    // The wall-clock time falls in a gap: apply the pre-change offset so it lands after the gap.
    return new Date(wallAsUtc - before * MINUTE);
  }
  return new Date(Math.min(...consistent));
}

/** Local calendar date, minute of day and weekday for an instant, in the given zone. */
export function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  const w = wallClock(instant, timeZone);
  const date = `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
  return {
    date,
    minutesOfDay: w.hour * 60 + w.minute,
    weekday: new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay(),
  };
}

function nextDate(date: string): string {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** The local day from midnight to the next midnight, as UTC instants (23 to 25 hours on DST days). */
export function localDayBounds(date: string, timeZone: string): TimeRange {
  return range(
    zonedTimeToInstant(date, '00:00', timeZone),
    zonedTimeToInstant(nextDate(date), '00:00', timeZone),
  );
}

/** Opening hours for a local date as UTC instants, or null when the dealership is closed that day. */
export function openingWindow(
  date: string,
  timeZone: string,
  hours: HoursByWeekday,
): TimeRange | null {
  const { year, month, day } = parseDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayHours = hours.get(weekday);
  if (!dayHours) return null;
  return range(
    zonedTimeToInstant(date, dayHours.open, timeZone),
    zonedTimeToInstant(date, dayHours.close, timeZone),
  );
}

export type WorkingHoursCheck =
  { ok: true } | { ok: false; reason: 'NOT_ALIGNED' | 'CLOSED_DAY' | 'OUTSIDE_HOURS' };

/**
 * Check that an appointment's whole occupied period (duration plus buffer) sits inside one
 * day's working hours, and that it starts on a 15-minute boundary of the local clock.
 * Problems are reported in this order: alignment, closed day, outside hours.
 */
export function checkWorkingHours(
  occupied: TimeRange,
  timeZone: string,
  hours: HoursByWeekday,
): WorkingHoursCheck {
  const startsOnWholeSecond = occupied.start.getTime() % 1000 === 0;
  const local = localDateTime(occupied.start, timeZone);
  const startSeconds = Math.floor(occupied.start.getTime() / 1000) % 60;
  if (!startsOnWholeSecond || startSeconds !== 0 || local.minutesOfDay % SLOT_MINUTES !== 0) {
    return { ok: false, reason: 'NOT_ALIGNED' };
  }

  const window = openingWindow(local.date, timeZone, hours);
  if (!window) return { ok: false, reason: 'CLOSED_DAY' };
  if (!contains(window, occupied)) return { ok: false, reason: 'OUTSIDE_HOURS' };
  return { ok: true };
}
