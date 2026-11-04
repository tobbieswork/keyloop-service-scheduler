import { describe, expect, it } from 'vitest';
import {
  qualifiedTechnicians,
  rankByLeastBooked,
  type TechnicianCandidate,
} from '../../src/domain/resource-selection.js';

const c = (id: string, bookedThatDay: number) => ({ id, bookedThatDay });

describe('rankByLeastBooked (FR-017)', () => {
  it('puts the resource with the fewest appointments that day first', () => {
    const ranked = rankByLeastBooked([c('a', 3), c('b', 1), c('c', 2)]);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties by the lowest ID', () => {
    const ranked = rankByLeastBooked([c('c', 1), c('a', 1), c('b', 1)]);
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic whatever order the input arrives in', () => {
    const input = [c('d', 2), c('a', 2), c('c', 0), c('b', 0), c('e', 5)];
    const expected = ['b', 'c', 'a', 'd', 'e'];
    for (let i = 0; i < 20; i++) {
      const shuffled = [...input].sort(() => Math.random() - 0.5);
      expect(rankByLeastBooked(shuffled).map((r) => r.id)).toEqual(expected);
    }
  });

  it('compares UUIDs the way the database does (byte order), regardless of letter case', () => {
    const low = '0a000000-0000-4000-8000-000000000000';
    const high = 'FF000000-0000-4000-8000-000000000000';
    expect(rankByLeastBooked([c(high, 0), c(low, 0)]).map((r) => r.id)).toEqual([low, high]);
  });

  it('returns an empty list for no candidates', () => {
    expect(rankByLeastBooked([])).toEqual([]);
  });

  it('does not change the list it was given', () => {
    const input = [c('b', 1), c('a', 0)];
    rankByLeastBooked(input);
    expect(input.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('keeps extra fields on the candidates', () => {
    const ranked = rankByLeastBooked([{ id: 'a', bookedThatDay: 0, name: 'Bay 1' }]);
    expect(ranked[0]?.name).toBe('Bay 1');
  });
});

describe('qualifiedTechnicians (FR-004)', () => {
  const tech = (id: string, skillIds: string[], bookedThatDay = 0): TechnicianCandidate => ({
    id,
    skillIds,
    bookedThatDay,
  });

  it('keeps only technicians who hold the required skill', () => {
    const result = qualifiedTechnicians(
      [tech('t1', ['brakes']), tech('t2', ['tyres']), tech('t3', ['brakes', 'tyres'])],
      'brakes',
    );
    expect(result.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  it('never returns a technician with no skills at all', () => {
    expect(qualifiedTechnicians([tech('t1', [])], 'brakes')).toEqual([]);
  });

  it('returns nothing when nobody holds the skill', () => {
    expect(qualifiedTechnicians([tech('t1', ['tyres'])], 'brakes')).toEqual([]);
  });

  it('is not swayed by how few appointments an unqualified technician has', () => {
    const qualified = qualifiedTechnicians(
      [tech('idle', ['tyres'], 0), tech('busy', ['brakes'], 9)],
      'brakes',
    );
    expect(rankByLeastBooked(qualified).map((t) => t.id)).toEqual(['busy']);
  });

  it('compares skill IDs exactly, not by prefix or case', () => {
    expect(
      qualifiedTechnicians([tech('t1', ['brakes-advanced']), tech('t2', ['Brakes'])], 'brakes'),
    ).toEqual([]);
  });
});
