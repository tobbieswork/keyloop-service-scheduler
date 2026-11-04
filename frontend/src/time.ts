/**
 * Time display for a booking UI.
 *
 * Every time is shown in the DEALERSHIP's time zone, never the browser's: a booking for "09:00"
 * has to mean the same thing to everyone booking for that dealership, wherever they sit. The zone
 * is therefore always passed in explicitly, and an unknown zone throws instead of quietly falling
 * back to the browser's.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const cacheKey = `${key}|${timeZone}`;
  let f = formatters.get(cacheKey);
  if (!f) {
    // Throws RangeError for an unknown zone.
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options });
    formatters.set(cacheKey, f);
  }
  return f;
}

function parts(f: Intl.DateTimeFormat, date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  return out;
}

/** '09:00 GMT': the clock time in the zone plus its offset label, so two "01:30"s on a clock-change day differ. */
export function formatTime(iso: string, timeZone: string): string {
  const p = parts(
    formatter('time', timeZone, {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }),
    new Date(iso),
  );
  return `${p['hour']}:${p['minute']} ${p['timeZoneName']}`;
}

/** 'Mon 4 Mar, 09:00 GMT': the dealership's date and time. */
export function formatDateTime(iso: string, timeZone: string): string {
  const d = parts(
    formatter('date', timeZone, { weekday: 'short', day: 'numeric', month: 'short' }),
    new Date(iso),
  );
  return `${d['weekday']} ${d['day']} ${d['month']}, ${formatTime(iso, timeZone)}`;
}

/** The calendar date ('YYYY-MM-DD') it is in the zone at that instant. */
export function localDateOf(instant: Date, timeZone: string): string {
  const p = parts(
    formatter('day', timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    instant,
  );
  return `${p['year']}-${p['month']}-${p['day']}`;
}

/** Tomorrow's date in the zone: the default day to look for a booking. */
export function tomorrowIn(timeZone: string, now: Date = new Date()): string {
  const [y, m, d] = localDateOf(now, timeZone).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
