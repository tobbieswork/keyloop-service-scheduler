import { describe, expect, it } from 'vitest';
import { contains, durationMinutes, overlaps, range } from '../../src/domain/time-range.js';

const at = (hhmm: string) => new Date(`2030-03-04T${hhmm}:00Z`);
const r = (start: string, end: string) => range(at(start), at(end));

describe('range', () => {
  it('builds a half-open range', () => {
    const x = r('09:00', '10:00');
    expect(x.start).toEqual(at('09:00'));
    expect(x.end).toEqual(at('10:00'));
  });

  it('rejects an empty range (end equals start)', () => {
    expect(() => r('09:00', '09:00')).toThrow(RangeError);
  });

  it('rejects an inverted range (end before start)', () => {
    expect(() => r('10:00', '09:00')).toThrow(RangeError);
  });

  it('rejects invalid dates', () => {
    expect(() => range(new Date('nope'), at('10:00'))).toThrow(RangeError);
  });
});

describe('overlaps', () => {
  it('is true for partial overlap, in either order', () => {
    expect(overlaps(r('09:00', '10:00'), r('09:30', '10:30'))).toBe(true);
    expect(overlaps(r('09:30', '10:30'), r('09:00', '10:00'))).toBe(true);
  });

  it('is true for identical ranges', () => {
    expect(overlaps(r('09:00', '10:00'), r('09:00', '10:00'))).toBe(true);
  });

  it('is true when one range sits inside the other', () => {
    expect(overlaps(r('09:00', '12:00'), r('10:00', '11:00'))).toBe(true);
    expect(overlaps(r('10:00', '11:00'), r('09:00', '12:00'))).toBe(true);
  });

  it('is FALSE for back-to-back ranges: end equals next start (FR-005)', () => {
    expect(overlaps(r('09:00', '10:00'), r('10:00', '11:00'))).toBe(false);
    expect(overlaps(r('10:00', '11:00'), r('09:00', '10:00'))).toBe(false);
  });

  it('is false for separate ranges', () => {
    expect(overlaps(r('09:00', '10:00'), r('11:00', '12:00'))).toBe(false);
  });

  it('is true when they share a single millisecond', () => {
    const a = range(new Date(0), new Date(1000));
    const b = range(new Date(999), new Date(2000));
    expect(overlaps(a, b)).toBe(true);
  });

  it('agrees with a brute-force check on every pair of small ranges', () => {
    // Model each range as a set of whole "cells" [start, end). Two ranges overlap
    // exactly when their cell sets intersect. This is independent of the formula used.
    const cells = (s: number, e: number) => new Set(Array.from({ length: e - s }, (_, i) => s + i));
    const make = (s: number, e: number) => range(new Date(s * 60_000), new Date(e * 60_000));
    let checked = 0;
    for (let a1 = 0; a1 <= 6; a1++)
      for (let a2 = a1 + 1; a2 <= 6; a2++)
        for (let b1 = 0; b1 <= 6; b1++)
          for (let b2 = b1 + 1; b2 <= 6; b2++) {
            const A = cells(a1, a2);
            const expected = [...cells(b1, b2)].some((c) => A.has(c));
            expect(overlaps(make(a1, a2), make(b1, b2)), `[${a1},${a2}) vs [${b1},${b2})`).toBe(
              expected,
            );
            checked++;
          }
    expect(checked).toBe(441);
  });
});

describe('contains', () => {
  it('is true when the inner range is inside or equal to the outer range', () => {
    expect(contains(r('08:00', '17:00'), r('09:00', '10:00'))).toBe(true);
    expect(contains(r('08:00', '17:00'), r('08:00', '17:00'))).toBe(true);
    expect(contains(r('08:00', '17:00'), r('16:00', '17:00'))).toBe(true);
  });

  it('is false when the inner range sticks out at either end', () => {
    expect(contains(r('08:00', '17:00'), r('07:45', '09:00'))).toBe(false);
    expect(contains(r('08:00', '17:00'), r('16:15', '17:15'))).toBe(false);
  });

  it('is false when the ranges are disjoint', () => {
    expect(contains(r('08:00', '09:00'), r('10:00', '11:00'))).toBe(false);
  });
});

describe('durationMinutes', () => {
  it('returns the length in whole minutes', () => {
    expect(durationMinutes(r('09:00', '10:30'))).toBe(90);
  });
});
