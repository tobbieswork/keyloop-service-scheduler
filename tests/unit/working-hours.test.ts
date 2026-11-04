import { describe, expect, it } from 'vitest';
import {
  checkWorkingHours,
  localDateTime,
  localDayBounds,
  openingWindow,
  zonedTimeToInstant,
  type HoursByWeekday,
} from '../../src/domain/working-hours.js';
import { range } from '../../src/domain/time-range.js';

// Weekday: 0 = Sunday ... 6 = Saturday. Same shape as the seed data for London.
const londonHours: HoursByWeekday = new Map([
  [1, { open: '08:00', close: '17:00' }],
  [2, { open: '08:00', close: '17:00' }],
  [3, { open: '08:00', close: '17:00' }],
  [4, { open: '08:00', close: '17:00' }],
  [5, { open: '08:00', close: '17:00' }],
  [6, { open: '09:00', close: '13:00' }],
]); // closed Sunday

// Open every day, so DST-change Sundays can be tested.
const everyDay = (open: string, close: string): HoursByWeekday =>
  new Map([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { open, close }]));

const slot = (startIso: string, minutes: number) => {
  const start = new Date(startIso);
  return range(start, new Date(start.getTime() + minutes * 60_000));
};

// Calendar facts used below (checked independently of the code):
//  - 2030-03-04 Monday, 2030-03-03 Sunday, 2030-03-09 Saturday
//  - London: GMT (UTC+0) in winter, BST (UTC+1) from Sun 2030-03-31 to Sun 2030-10-27
//  - New York: EST (UTC-5) in winter, EDT (UTC-4) from Sun 2030-03-10 to Sun 2030-11-03
//  - 2030-07-01 is a Monday

describe('zonedTimeToInstant', () => {
  it.each([
    ['London winter (GMT)', '2030-03-04', '08:00', 'Europe/London', '2030-03-04T08:00:00.000Z'],
    ['London summer (BST)', '2030-07-01', '08:00', 'Europe/London', '2030-07-01T07:00:00.000Z'],
    [
      'New York winter (EST)',
      '2030-01-07',
      '08:00',
      'America/New_York',
      '2030-01-07T13:00:00.000Z',
    ],
    [
      'New York summer (EDT)',
      '2030-07-01',
      '08:00',
      'America/New_York',
      '2030-07-01T12:00:00.000Z',
    ],
    [
      'India, a half-hour offset',
      '2030-03-04',
      '08:00',
      'Asia/Kolkata',
      '2030-03-04T02:30:00.000Z',
    ],
    ['seconds are honoured', '2030-03-04', '08:00:30', 'Europe/London', '2030-03-04T08:00:30.000Z'],
  ])('%s', (_name, date, time, tz, expected) => {
    expect(zonedTimeToInstant(date, time, tz).toISOString()).toBe(expected);
  });

  it('picks the EARLIER moment when a local time happens twice (clocks go back)', () => {
    // London 2030-10-27: 02:00 BST falls back to 01:00 GMT, so 01:30 happens twice.
    // 00:30Z is 01:30 BST (first time), 01:30Z is 01:30 GMT (second time).
    expect(zonedTimeToInstant('2030-10-27', '01:30', 'Europe/London').toISOString()).toBe(
      '2030-10-27T00:30:00.000Z',
    );
  });

  it('moves FORWARD when a local time does not exist (clocks go forward)', () => {
    // London 2030-03-31: 01:00 GMT jumps to 02:00 BST, so 01:30 never happens.
    // The result is 01:30Z, which is 02:30 BST on the wall clock.
    expect(zonedTimeToInstant('2030-03-31', '01:30', 'Europe/London').toISOString()).toBe(
      '2030-03-31T01:30:00.000Z',
    );
  });

  it('throws for an unknown time zone', () => {
    expect(() => zonedTimeToInstant('2030-03-04', '08:00', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('localDateTime', () => {
  it('reports the dealership-local date, minute of day and weekday', () => {
    const l = localDateTime(new Date('2030-03-04T23:30:00Z'), 'America/New_York'); // EST: 18:30
    expect(l).toMatchObject({ date: '2030-03-04', minutesOfDay: 18 * 60 + 30, weekday: 1 });
  });

  it('rolls over to the next local date when the local clock passes midnight', () => {
    const l = localDateTime(new Date('2030-07-01T23:30:00Z'), 'Europe/London'); // BST: 00:30 next day
    expect(l).toMatchObject({ date: '2030-07-02', minutesOfDay: 30, weekday: 2 });
  });

  it('reports the local date for an instant that is still "yesterday" in the zone', () => {
    const l = localDateTime(new Date('2030-03-04T02:00:00Z'), 'America/New_York'); // EST: 21:00 on 03-03
    expect(l).toMatchObject({ date: '2030-03-03', weekday: 0 });
  });
});

describe('localDayBounds', () => {
  const hoursBetween = (date: string, tz: string) => {
    const { start, end } = localDayBounds(date, tz);
    return (end.getTime() - start.getTime()) / 3_600_000;
  };

  it('is 24 hours on an ordinary day', () => {
    expect(hoursBetween('2030-03-04', 'Europe/London')).toBe(24);
  });

  it('is 23 hours on the day clocks go forward', () => {
    expect(hoursBetween('2030-03-31', 'Europe/London')).toBe(23);
    expect(hoursBetween('2030-03-10', 'America/New_York')).toBe(23);
  });

  it('is 25 hours on the day clocks go back', () => {
    expect(hoursBetween('2030-10-27', 'Europe/London')).toBe(25);
    expect(hoursBetween('2030-11-03', 'America/New_York')).toBe(25);
  });

  it('starts at local midnight', () => {
    expect(localDayBounds('2030-07-01', 'Europe/London').start.toISOString()).toBe(
      '2030-06-30T23:00:00.000Z', // midnight BST
    );
  });
});

describe('openingWindow', () => {
  it('returns the opening hours as UTC instants for an open day', () => {
    const w = openingWindow('2030-03-04', 'Europe/London', londonHours);
    expect(w?.start.toISOString()).toBe('2030-03-04T08:00:00.000Z');
    expect(w?.end.toISOString()).toBe('2030-03-04T17:00:00.000Z');
  });

  it('returns null for a closed day', () => {
    expect(openingWindow('2030-03-03', 'Europe/London', londonHours)).toBeNull(); // Sunday
  });

  it('shifts with daylight saving: 08:00-17:00 on the day clocks go forward', () => {
    const w = openingWindow('2030-03-31', 'Europe/London', everyDay('08:00', '17:00'));
    expect(w?.start.toISOString()).toBe('2030-03-31T07:00:00.000Z'); // 08:00 BST
    expect(w?.end.toISOString()).toBe('2030-03-31T16:00:00.000Z');
  });
});

describe('checkWorkingHours', () => {
  const check = (startIso: string, minutes: number, tz = 'Europe/London', hours = londonHours) =>
    checkWorkingHours(slot(startIso, minutes), tz, hours);

  describe('accepts', () => {
    it('a slot at the very start of the day', () => {
      expect(check('2030-03-04T08:00:00Z', 60)).toEqual({ ok: true });
    });

    it('a slot ending exactly at closing time (the end is exclusive)', () => {
      expect(check('2030-03-04T16:00:00Z', 60)).toEqual({ ok: true });
    });

    it('a shorter Saturday window', () => {
      expect(check('2030-03-09T09:00:00Z', 60)).toEqual({ ok: true });
      expect(check('2030-03-09T12:00:00Z', 60)).toEqual({ ok: true });
    });
  });

  describe('rejects', () => {
    it('a start before opening (07:45)', () => {
      expect(check('2030-03-04T07:45:00Z', 60)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' });
    });

    it('an end after closing, even when the start is inside', () => {
      expect(check('2030-03-04T16:15:00Z', 60)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' });
    });

    it('a start after closing', () => {
      expect(check('2030-03-04T17:00:00Z', 30)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' });
    });

    it('a Saturday slot that runs past the shorter 13:00 closing', () => {
      expect(check('2030-03-09T12:30:00Z', 60)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' });
    });

    it('a closed day (Sunday)', () => {
      expect(check('2030-03-03T10:00:00Z', 60)).toEqual({ ok: false, reason: 'CLOSED_DAY' });
    });

    it('a slot that runs past midnight into the next day', () => {
      const lateHours = everyDay('08:00', '23:00');
      expect(check('2030-03-04T22:30:00Z', 120, 'Europe/London', lateHours)).toEqual({
        ok: false,
        reason: 'OUTSIDE_HOURS',
      });
    });
  });

  describe('15-minute alignment in LOCAL time', () => {
    it('rejects a start that is not on a 15-minute boundary', () => {
      expect(check('2030-03-04T08:10:00Z', 60)).toEqual({ ok: false, reason: 'NOT_ALIGNED' });
      expect(check('2030-03-04T08:07:00Z', 60)).toEqual({ ok: false, reason: 'NOT_ALIGNED' });
    });

    it('rejects a start with seconds or milliseconds', () => {
      expect(check('2030-03-04T08:00:30Z', 60)).toEqual({ ok: false, reason: 'NOT_ALIGNED' });
      expect(check('2030-03-04T08:00:00.500Z', 60)).toEqual({ ok: false, reason: 'NOT_ALIGNED' });
    });

    it('accepts 08:15, 08:30 and 08:45', () => {
      for (const m of ['08:15', '08:30', '08:45']) {
        expect(check(`2030-03-04T${m}:00Z`, 30)).toEqual({ ok: true });
      }
    });

    // Note: every real zone offset is a multiple of 15 minutes, so alignment in UTC and in local
    // time always agree today. The code still measures the local clock because that is what the
    // spec says; this test checks that unusual offsets work, not that the two methods differ.
    it('works in zones with half-hour and 45-minute offsets', () => {
      // India is UTC+5:30. 02:30Z is 08:00 local: aligned. 02:40Z is 08:10 local: not.
      const india = everyDay('08:00', '18:00');
      expect(check('2030-03-04T02:30:00Z', 60, 'Asia/Kolkata', india)).toEqual({ ok: true });
      expect(check('2030-03-04T02:40:00Z', 60, 'Asia/Kolkata', india)).toEqual({
        ok: false,
        reason: 'NOT_ALIGNED',
      });
      // Nepal is UTC+5:45. 02:15Z is 08:00 local: aligned. 02:20Z is 08:05 local: not.
      expect(check('2030-03-04T02:15:00Z', 60, 'Asia/Kathmandu', india)).toEqual({ ok: true });
      expect(check('2030-03-04T02:20:00Z', 60, 'Asia/Kathmandu', india)).toEqual({
        ok: false,
        reason: 'NOT_ALIGNED',
      });
    });

    it('reports misalignment before other problems', () => {
      expect(check('2030-03-03T10:10:00Z', 60)).toEqual({ ok: false, reason: 'NOT_ALIGNED' });
    });
  });

  describe('time zones and daylight saving', () => {
    it('uses the dealership zone, not UTC: summer London opens at 07:00Z', () => {
      expect(check('2030-07-01T07:00:00Z', 60)).toEqual({ ok: true }); // 08:00 BST
      expect(check('2030-07-01T06:00:00Z', 60)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' }); // 07:00 BST
      expect(check('2030-07-01T15:00:00Z', 60)).toEqual({ ok: true }); // 16:00-17:00 BST
      expect(check('2030-07-01T16:00:00Z', 60)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' }); // 17:00 BST
    });

    it('treats the same instant differently in different zones', () => {
      // 2030-03-18: London is on GMT, New York is already on EDT (UTC-4).
      const ny = everyDay('07:00', '18:00');
      const london = everyDay('08:00', '17:00');
      // 12:00Z = 12:00 London, 08:00 New York: open in both.
      expect(check('2030-03-18T12:00:00Z', 60, 'Europe/London', london)).toEqual({ ok: true });
      expect(check('2030-03-18T12:00:00Z', 60, 'America/New_York', ny)).toEqual({ ok: true });
      // 08:00Z = 08:00 London (open), 04:00 New York (closed).
      expect(check('2030-03-18T08:00:00Z', 60, 'Europe/London', london)).toEqual({ ok: true });
      expect(check('2030-03-18T08:00:00Z', 60, 'America/New_York', ny)).toEqual({
        ok: false,
        reason: 'OUTSIDE_HOURS',
      });
    });

    it('opens an hour earlier in UTC on the day clocks go forward (London 2030-03-31)', () => {
      const hours = everyDay('08:00', '17:00');
      expect(check('2030-03-31T07:00:00Z', 60, 'Europe/London', hours)).toEqual({ ok: true }); // 08:00 BST
      expect(check('2030-03-31T06:45:00Z', 60, 'Europe/London', hours)).toEqual({
        ok: false,
        reason: 'OUTSIDE_HOURS',
      });
      expect(check('2030-03-31T15:00:00Z', 60, 'Europe/London', hours)).toEqual({ ok: true }); // ends 17:00 BST
      expect(check('2030-03-31T15:15:00Z', 60, 'Europe/London', hours)).toEqual({
        ok: false,
        reason: 'OUTSIDE_HOURS',
      });
    });

    it('is back to normal on the day clocks go back (London 2030-10-27)', () => {
      const hours = everyDay('08:00', '17:00');
      expect(check('2030-10-27T08:00:00Z', 60, 'Europe/London', hours)).toEqual({ ok: true }); // 08:00 GMT
      expect(check('2030-10-27T07:00:00Z', 60, 'Europe/London', hours)).toEqual({
        ok: false,
        reason: 'OUTSIDE_HOURS',
      });
    });

    it('handles New York spring-forward (2030-03-10): 07:00 EDT is 11:00Z', () => {
      const hours = everyDay('07:00', '18:00');
      expect(check('2030-03-10T11:00:00Z', 60, 'America/New_York', hours)).toEqual({ ok: true });
      expect(check('2030-03-10T10:45:00Z', 60, 'America/New_York', hours)).toEqual({
        ok: false,
        reason: 'OUTSIDE_HOURS',
      });
    });

    it('throws for an unknown time zone', () => {
      expect(() => check('2030-03-04T08:00:00Z', 60, 'Mars/Olympus')).toThrow(RangeError);
    });
  });
});
