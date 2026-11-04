import { describe, expect, it } from 'vitest';
import { occupiedPeriod } from '../../src/domain/occupied-period.js';

const start = new Date('2030-03-04T09:00:00.000Z');

describe('occupiedPeriod (FR-002)', () => {
  it('is the service duration plus the buffer', () => {
    const { occupied, serviceEnd } = occupiedPeriod(start, 45, 15);
    expect(serviceEnd.toISOString()).toBe('2030-03-04T09:45:00.000Z');
    expect(occupied.start).toEqual(start);
    expect(occupied.end.toISOString()).toBe('2030-03-04T10:00:00.000Z');
  });

  it('works with a zero buffer: the occupied period equals the service time', () => {
    const { occupied, serviceEnd } = occupiedPeriod(start, 60, 0);
    expect(serviceEnd.toISOString()).toBe('2030-03-04T10:00:00.000Z');
    expect(occupied.end).toEqual(serviceEnd);
  });

  it('keeps the service end separate from the occupied end, so the buffer is not shown as work', () => {
    const { occupied, serviceEnd } = occupiedPeriod(start, 90, 10);
    expect(occupied.end.getTime() - serviceEnd.getTime()).toBe(10 * 60_000);
  });

  it('does not change the start date it was given', () => {
    const before = start.getTime();
    occupiedPeriod(start, 60, 15);
    expect(start.getTime()).toBe(before);
  });

  it.each([
    ['zero duration', 0, 0],
    ['negative duration', -30, 0],
    ['fractional duration', 30.5, 0],
    ['negative buffer', 60, -5],
    ['fractional buffer', 60, 2.5],
    ['NaN duration', Number.NaN, 0],
  ])('rejects %s', (_name, duration, buffer) => {
    expect(() => occupiedPeriod(start, duration, buffer)).toThrow(RangeError);
  });
});
