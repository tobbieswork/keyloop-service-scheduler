import { describe, expect, it } from 'vitest';
import { formatDateTime, formatTime, localDateOf, tomorrowIn } from './time';

// Calendar facts used below (independent of the code under test):
//  - London: GMT (UTC+0) in winter, BST (UTC+1) from Sun 2030-03-31 to Sun 2030-10-27
//  - New York: EST (UTC-5) in winter, EDT (UTC-4) from Sun 2030-03-10 to Sun 2030-11-03
//  - 2030-03-04 is a Monday and 2030-07-01 is a Monday

describe('formatTime: shows the time in the DEALERSHIP zone, never the browser zone', () => {
  it.each([
    ['London in winter (GMT)', '2030-03-04T09:00:00.000Z', 'Europe/London', '09:00 GMT'],
    ['London in summer (BST)', '2030-07-01T07:00:00.000Z', 'Europe/London', '08:00 BST'],
    ['New York in winter (UTC-5)', '2030-03-04T14:00:00.000Z', 'America/New_York', '09:00 GMT-5'],
    ['New York in summer (UTC-4)', '2030-07-01T12:00:00.000Z', 'America/New_York', '08:00 GMT-4'],
    ['midnight is 00:00, never 24:00', '2030-03-04T00:00:00.000Z', 'Europe/London', '00:00 GMT'],
    ['a half-hour zone (India)', '2030-03-04T02:30:00.000Z', 'Asia/Kolkata', '08:00 GMT+5:30'],
  ])('%s', (_name, iso, zone, expected) => {
    expect(formatTime(iso, zone)).toBe(expected);
  });

  it('shows the same instant differently in different zones (the point of the feature)', () => {
    const iso = '2030-03-18T12:00:00.000Z'; // London is on GMT, New York already on EDT
    expect(formatTime(iso, 'Europe/London')).toBe('12:00 GMT');
    expect(formatTime(iso, 'America/New_York')).toBe('08:00 GMT-4');
  });

  it('follows the day clocks go forward (London 2030-03-31)', () => {
    expect(formatTime('2030-03-31T00:30:00.000Z', 'Europe/London')).toBe('00:30 GMT');
    expect(formatTime('2030-03-31T07:00:00.000Z', 'Europe/London')).toBe('08:00 BST');
  });

  it('tells the two 01:30s apart on the day clocks go back (London 2030-10-27)', () => {
    expect(formatTime('2030-10-27T00:30:00.000Z', 'Europe/London')).toBe('01:30 BST');
    expect(formatTime('2030-10-27T01:30:00.000Z', 'Europe/London')).toBe('01:30 GMT');
  });

  it('is not changed by the machine running the tests', () => {
    // The same answer whatever TZ the process has: the zone is always passed explicitly.
    const before = process.env['TZ'];
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env['TZ'] = tz;
      expect(formatTime('2030-03-04T09:00:00.000Z', 'Europe/London')).toBe('09:00 GMT');
    }
    if (before === undefined) delete process.env['TZ'];
    else process.env['TZ'] = before;
  });

  it('throws for an unknown time zone instead of silently using the browser one', () => {
    expect(() => formatTime('2030-03-04T09:00:00.000Z', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('formatDateTime', () => {
  it('shows weekday, day, month and the local time', () => {
    expect(formatDateTime('2030-03-04T09:00:00.000Z', 'Europe/London')).toBe('Mon 4 Mar, 09:00 GMT');
  });

  it('uses the dealership date, which can differ from the UTC date', () => {
    // 23:30 UTC on 4 July is already 00:30 on 5 July in London (BST).
    expect(formatDateTime('2030-07-04T23:30:00.000Z', 'Europe/London')).toBe('Fri 5 Jul, 00:30 BST');
  });
});

describe('localDateOf', () => {
  it('returns the calendar date in the zone', () => {
    expect(localDateOf(new Date('2030-03-04T23:30:00.000Z'), 'America/New_York')).toBe('2030-03-04');
    expect(localDateOf(new Date('2030-07-01T23:30:00.000Z'), 'Europe/London')).toBe('2030-07-02');
    expect(localDateOf(new Date('2030-03-04T02:00:00.000Z'), 'America/New_York')).toBe('2030-03-03');
  });
});

describe('tomorrowIn: the default date for a dealership', () => {
  const at = (iso: string) => new Date(iso);

  it('is the next calendar day in the dealership zone', () => {
    expect(tomorrowIn('Europe/London', at('2030-03-04T09:00:00.000Z'))).toBe('2030-03-05');
  });

  it('uses the dealership clock, not UTC: late evening UTC is already "tomorrow" in London summer', () => {
    // 23:30 UTC on 1 July is 00:30 on 2 July in London, so "tomorrow" is the 3rd.
    expect(tomorrowIn('Europe/London', at('2030-07-01T23:30:00.000Z'))).toBe('2030-07-03');
  });

  it('can be earlier than the UTC date: 02:00 UTC is still the evening before in New York', () => {
    expect(tomorrowIn('America/New_York', at('2030-03-04T02:00:00.000Z'))).toBe('2030-03-04');
  });

  it('rolls over month ends and leap days', () => {
    expect(tomorrowIn('Europe/London', at('2030-02-28T12:00:00.000Z'))).toBe('2030-03-01');
    expect(tomorrowIn('Europe/London', at('2028-02-28T12:00:00.000Z'))).toBe('2028-02-29');
    expect(tomorrowIn('Europe/London', at('2030-12-31T12:00:00.000Z'))).toBe('2031-01-01');
  });
});
