import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, monday, newKey, startApi, type TestApi } from './helpers/api.js';
import { startTestDb, type TestDb } from './helpers/db.js';
import { createWorld } from './helpers/fixtures.js';

let testDb: TestDb;
let api: TestApi;

beforeAll(async () => {
  testDb = await startTestDb();
  api = await startApi(testDb);
});
afterAll(async () => {
  await api.app.close();
  await testDb.stop();
});
beforeEach(async () => {
  await testDb.reset();
});

const ROUNDS = 5; // each scenario is repeated, because races only show up some of the time

const appointments = async () => {
  const { rows } = await sql<{ id: string; bay_id: string; technician_id: string; status: string }>`
    SELECT id, bay_id, technician_id, status FROM appointment`.execute(testDb.db);
  return rows;
};
const tally = (codes: number[]) => {
  const t: Record<number, number> = {};
  for (const c of codes) t[c] = (t[c] ?? 0) + 1;
  return t;
};

describe('simultaneous requests for the last slot (US3, SC-001)', () => {
  it.each(Array.from({ length: ROUNDS }, (_, i) => i + 1))(
    'round %i: 20 parallel requests for the only slot give exactly one 201 and nineteen 409s',
    async () => {
      await testDb.reset();
      const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => api.book(bookingBody(world, monday('09:00')), newKey())),
      );

      expect(tally(responses.map((r) => r.statusCode))).toEqual({ 201: 1, 409: 19 });
      expect((await appointments()).filter((a) => a.status === 'confirmed')).toHaveLength(1);
      for (const r of responses.filter((x) => x.statusCode === 409)) {
        expect(r.json().error.code).toBe('SLOT_UNAVAILABLE');
      }
    },
  );

  it.each(Array.from({ length: ROUNDS }, (_, i) => i + 1))(
    'round %i: 30 requests for 6 slots give exactly 6 confirmed, each on its own bay and technician',
    async () => {
      await testDb.reset();
      const world = await createWorld(testDb.db, { withHours: true, bays: 6, technicians: 6 });

      const responses = await Promise.all(
        Array.from({ length: 30 }, () => api.book(bookingBody(world, monday('09:00')), newKey())),
      );

      // No false "full": every one of the 6 places is used, nobody is turned away while capacity is left.
      expect(tally(responses.map((r) => r.statusCode))).toEqual({ 201: 6, 409: 24 });
      const confirmed = await appointments();
      expect(confirmed).toHaveLength(6);
      expect(new Set(confirmed.map((a) => a.bay_id)).size).toBe(6);
      expect(new Set(confirmed.map((a) => a.technician_id)).size).toBe(6);
    },
  );

  it('never double-books even when bays are plentiful but there is one technician', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 10, technicians: 1 });
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => api.book(bookingBody(world, monday('09:00')), newKey())),
    );
    expect(tally(responses.map((r) => r.statusCode))).toEqual({ 201: 1, 409: 19 });
  });

  it('never double-books overlapping (not identical) times', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const starts = ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45'];
    const responses = await Promise.all(
      starts.flatMap((s) => [1, 2, 3].map(() => api.book(bookingBody(world, monday(s)), newKey()))),
    );
    const ok = responses.filter((r) => r.statusCode === 201).length;
    expect(ok).toBeGreaterThan(0);
    expect(responses.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);

    // Whatever was confirmed must not overlap: sort by start and compare neighbours.
    const { rows } = await sql<{ s: Date; e: Date }>`
      SELECT lower(occupied_period) AS s, upper(occupied_period) AS e FROM appointment
       WHERE status = 'confirmed' ORDER BY 1`.execute(testDb.db);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.s.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.e.getTime());
    }
  });

  it('keeps working across different dealerships at the same time', async () => {
    const a = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const b = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      sharedWith: a,
    });
    const responses = await Promise.all([
      ...Array.from({ length: 10 }, () => api.book(bookingBody(a, monday('09:00')), newKey())),
      ...Array.from({ length: 10 }, () => api.book(bookingBody(b, monday('09:00')), newKey())),
    ]);
    expect(tally(responses.map((r) => r.statusCode))).toEqual({ 201: 2, 409: 18 });
  });
});

describe('simultaneous requests with the SAME idempotency key (FR-016)', () => {
  it.each(Array.from({ length: ROUNDS }, (_, i) => i + 1))(
    'round %i: 12 parallel copies give one appointment and the same ID to every caller',
    async () => {
      await testDb.reset();
      const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 12 }, () => api.book(bookingBody(world, monday('09:00')), key)),
      );

      // One request creates it (201); the rest are told what already exists (200). Never a 409 or 500.
      expect(responses.every((r) => r.statusCode === 201 || r.statusCode === 200)).toBe(true);
      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
      expect(await appointments()).toHaveLength(1);
    },
  );

  it('with spare capacity, still creates only one appointment for one key', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 5, technicians: 5 });
    const key = newKey();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => api.book(bookingBody(world, monday('09:00')), key)),
    );
    expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
    expect(await appointments()).toHaveLength(1);
  });
});
