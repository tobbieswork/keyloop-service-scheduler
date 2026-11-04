/**
 * A half-open time range [start, end): it includes `start` and excludes `end`.
 * That is what makes back-to-back appointments legal: one ending at 10:00 and the next
 * starting at 10:00 do not overlap. The database uses the same convention (`tstzrange '[)'`).
 */
export interface TimeRange {
  readonly start: Date;
  readonly end: Date;
}

/** Build a range. Empty or inverted ranges are never valid in this system, so they throw. */
export function range(start: Date, end: Date): TimeRange {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new RangeError('Time range needs valid dates');
  }
  if (end.getTime() <= start.getTime()) {
    throw new RangeError('Time range end must be after its start');
  }
  return { start, end };
}

/** True when the two ranges share any moment. Touching ends (end equals other start) do not count. */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** True when `inner` lies entirely within `outer` (sharing an end is fine). */
export function contains(outer: TimeRange, inner: TimeRange): boolean {
  return (
    outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime()
  );
}

export function durationMinutes(r: TimeRange): number {
  return (r.end.getTime() - r.start.getTime()) / 60_000;
}
