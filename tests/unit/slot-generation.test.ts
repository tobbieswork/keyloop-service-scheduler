import { describe, expect, it } from 'vitest';
import { range, type TimeRange } from '../../src/domain/time-range.js';
import { generateSlots, type SlotRequest } from '../../src/domain/slot-generation.js';
import type { HoursByWeekday } from '../../src/domain/working-hours.js';

// 2030-03-04 is a Monday in winter time: London local time equals UTC.
const londonHours: HoursByWeekday = new Map(
  [1, 2, 3, 4, 5].map((d) => [d, { open: '08:00', close: '17:00' }]),
);
const everyDay = (open: string, close: string): HoursByWeekday =>
  new Map([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { open, close }]));

const at = (hhmm: string, day = '2030-03-04') => new Date(`${day}T${hhmm}:00.000Z`);
const busy = (from: string, to: string, day = '2030-03-04'): TimeRange =>
  range(at(from, day), at(to, day));
const free = (id: string) => ({ id, busy: [] as TimeRange[] });

const base: SlotRequest = {
  date: '2030-03-04',
  timeZone: 'Europe/London',
  hours: londonHours,
  durationMinutes: 60,
  bufferMinutes: 0,
  bays: [free('bay-1')],
  technicians: [free('tech-1')],
  now: new Date('2030-03-01T00:00:00.000Z'),
};
const starts = (req: Partial<SlotRequest> = {}) =>
  generateSlots({ ...base, ...req }).map((s) => s.startTime.toISOString().slice(11, 16));

describe('generateSlots: the 15-minute grid inside opening hours', () => {
  it('offers every 15 minutes from opening until the last start that still ends by closing', () => {
    const result = starts();
    expect(result[0]).toBe('08:00');
    expect(result.at(-1)).toBe('16:00'); // 16:00 + 60 min ends exactly at 17:00 closing
    expect(result).toHaveLength(33); // (16:00 - 08:00) / 15 min + 1
  });

  it('includes a slot that ends exactly at closing, and excludes one minute-grid step later', () => {
    const result = starts();
    expect(result).toContain('16:00');
    expect(result).not.toContain('16:15');
  });

  it('counts the buffer when fitting: 60 + 30 = 90 minutes ends by 17:00 only if it starts by 15:30', () => {
    const result = starts({ bufferMinutes: 30 });
    expect(result.at(-1)).toBe('15:30');
  });

  it('returns slots in time order, with no duplicates', () => {
    const result = starts({ bays: [free('a'), free('b')], technicians: [free('x'), free('y')] });
    expect(result).toEqual([...new Set(result)].sort());
  });

  it('reports each slot end as the end of the occupied period (duration plus buffer)', () => {
    const [first] = generateSlots({ ...base, durationMinutes: 45, bufferMinutes: 15 });
    expect(first?.startTime).toEqual(at('08:00'));
    expect(first?.endTime).toEqual(at('09:00'));
  });

  it('starts on the first 15-minute boundary at or after opening when opening is not aligned', () => {
    const result = starts({ hours: everyDay('08:10', '17:00') });
    expect(result[0]).toBe('08:15');
  });
});

describe('generateSlots: closed days and empty capacity', () => {
  it('returns nothing on a closed day', () => {
    expect(starts({ date: '2030-03-03' })).toEqual([]); // Sunday
  });

  it('returns nothing when there are no bays', () => {
    expect(starts({ bays: [] })).toEqual([]);
  });

  it('returns nothing when there are no qualified technicians', () => {
    expect(starts({ technicians: [] })).toEqual([]);
  });

  it('returns nothing when the service is longer than the working day', () => {
    expect(starts({ durationMinutes: 600 })).toEqual([]);
  });

  it('returns nothing when the only bay is busy all day', () => {
    expect(starts({ bays: [{ id: 'bay-1', busy: [busy('08:00', '17:00')] }] })).toEqual([]);
  });
});

describe('generateSlots: booked time removes the starts it overlaps', () => {
  const oneBayBusy = { bays: [{ id: 'bay-1', busy: [busy('09:00', '10:00')] }] };

  it('removes exactly the starts whose period overlaps, keeping back-to-back starts', () => {
    const result = starts(oneBayBusy);
    expect(result).toContain('08:00'); // ends at 09:00, exactly when the booking starts
    expect(result).not.toContain('08:15'); // would run into the booking
    expect(result).not.toContain('09:00');
    expect(result).not.toContain('09:45');
    expect(result).toContain('10:00'); // starts exactly when the booking ends
  });

  it('removes the same starts when it is the technician who is busy', () => {
    expect(starts({ technicians: [{ id: 'tech-1', busy: [busy('09:00', '10:00')] }] })).toEqual(
      starts(oneBayBusy),
    );
  });

  it('keeps a start when a second bay is free', () => {
    const result = starts({
      bays: [{ id: 'bay-1', busy: [busy('09:00', '10:00')] }, free('bay-2')],
    });
    expect(result).toContain('09:00');
  });

  it('needs a bay AND a technician: a free bay alone is not enough', () => {
    const result = starts({
      bays: [free('bay-1'), free('bay-2')],
      technicians: [{ id: 'tech-1', busy: [busy('09:00', '10:00')] }],
    });
    expect(result).not.toContain('09:00');
  });

  it('needs ONE bay free for the whole period, not several bays that are each free for part of it', () => {
    // Bay A is busy 09:00-10:00, bay B is busy 10:00-11:00. A 60-minute job at 09:30 runs to 10:30:
    // A is busy at the start and B is busy at the end, so no single bay can take it.
    const result = starts({
      bays: [
        { id: 'a', busy: [busy('09:00', '10:00')] },
        { id: 'b', busy: [busy('10:00', '11:00')] },
      ],
    });
    expect(result).not.toContain('09:30');
    expect(result).not.toContain('09:15');
    expect(result).not.toContain('10:15');
  });

  it('needs ONE technician free for the whole period too', () => {
    const result = starts({
      technicians: [
        { id: 'a', busy: [busy('09:00', '10:00')] },
        { id: 'b', busy: [busy('10:00', '11:00')] },
      ],
    });
    expect(result).not.toContain('09:30');
  });

  it('ignores busy time on other days', () => {
    const other = busy('09:00', '10:00', '2030-03-05');
    expect(starts({ bays: [{ id: 'bay-1', busy: [other] }] })).toHaveLength(33);
  });

  it('copes with several busy intervals on one resource', () => {
    const result = starts({
      bays: [
        {
          id: 'bay-1',
          busy: [busy('08:00', '09:00'), busy('12:00', '13:00'), busy('15:00', '16:00')],
        },
      ],
    });
    expect(result).toContain('09:00');
    expect(result).toContain('11:00'); // ends exactly at 12:00
    expect(result).not.toContain('11:15');
    expect(result).toContain('13:00');
    expect(result).toContain('14:00'); // ends exactly at 15:00
    expect(result).not.toContain('14:15');
    expect(result).toContain('16:00');
  });
});

describe('generateSlots: the clock', () => {
  it('never offers a start that is not in the future', () => {
    const result = starts({ now: new Date('2030-03-04T09:10:00.000Z') });
    expect(result[0]).toBe('09:15');
  });

  it('offers nothing once the whole day has passed', () => {
    expect(starts({ now: new Date('2030-03-04T20:00:00.000Z') })).toEqual([]);
  });

  it('does not offer a start equal to now (a booking must be strictly in the future)', () => {
    expect(starts({ now: at('09:00') })).not.toContain('09:00');
    expect(starts({ now: at('09:00') })).toContain('09:15');
  });
});

describe('generateSlots: time zones and daylight saving', () => {
  it('uses the dealership zone: 08:00 summer London time is 07:00Z', () => {
    const [first] = generateSlots({ ...base, date: '2030-07-01' });
    expect(first?.startTime.toISOString()).toBe('2030-07-01T07:00:00.000Z');
  });

  it('opens an hour earlier in UTC on the day clocks go forward (London 2030-03-31)', () => {
    const result = generateSlots({
      ...base,
      date: '2030-03-31',
      hours: everyDay('08:00', '17:00'),
    });
    expect(result[0]?.startTime.toISOString()).toBe('2030-03-31T07:00:00.000Z');
    expect(result.at(-1)?.startTime.toISOString()).toBe('2030-03-31T15:00:00.000Z');
  });

  it('handles New York: 08:00 EST is 13:00Z', () => {
    const result = generateSlots({
      ...base,
      timeZone: 'America/New_York',
      hours: everyDay('08:00', '17:00'),
    });
    expect(result[0]?.startTime.toISOString()).toBe('2030-03-04T13:00:00.000Z');
  });

  it('keeps a full grid on a 25-hour day (London 2030-10-27, clocks go back)', () => {
    const result = generateSlots({
      ...base,
      date: '2030-10-27',
      hours: everyDay('08:00', '17:00'),
    });
    expect(result).toHaveLength(33); // opening hours are still 9 local hours
    expect(result[0]?.startTime.toISOString()).toBe('2030-10-27T08:00:00.000Z');
  });
});
