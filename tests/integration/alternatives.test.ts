import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, monday, NOW, startApi, type TestApi } from './helpers/api.js';
import { startTestDb, type TestDb } from './helpers/db.js';
import { createWorld, type World } from './helpers/fixtures.js';

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
  api.setNow(NOW);
});

type Alt = { startTime: string; endTime: string };
const conflictFor = async (world: World, start: string) => {
  const res = await api.book(bookingBody(world, start));
  expect(res.statusCode).toBe(409);
  return res.json() as { error: { code: string }; alternatives: Alt[] };
};
const day = (iso: string) => iso.slice(0, 10);
const time = (iso: string) => iso.slice(11, 16);

describe('alternative slots on a capacity conflict (FR-009, SC-003)', () => {
  it('offers up to 5 slots, the requested day first, in time order', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.book(bookingBody(world, monday('09:00')));

    const { alternatives } = await conflictFor(world, monday('09:00'));

    expect(alternatives).toHaveLength(5);
    // 08:00 ends exactly when the 09:00 booking starts; 10:00 starts exactly when it ends.
    expect(alternatives.map((a) => time(a.startTime))).toEqual([
      '08:00',
      '10:00',
      '10:15',
      '10:30',
      '10:45',
    ]);
    expect(alternatives.every((a) => day(a.startTime) === '2030-03-04')).toBe(true);
    const sorted = [...alternatives].sort((a, b) => a.startTime.localeCompare(b.startTime));
    expect(alternatives).toEqual(sorted);
  });

  it('gives each alternative with an end that includes the buffer', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      durationMinutes: 45,
      bufferMinutes: 15,
    });
    await api.book(bookingBody(world, monday('09:00')));
    const { alternatives } = await conflictFor(world, monday('09:00'));
    expect(alternatives[0]).toEqual({
      startTime: '2030-03-04T08:00:00.000Z',
      endTime: '2030-03-04T09:00:00.000Z',
    });
  });

  it('moves on to following days when the requested day is full', async () => {
    // A 9-hour service fills the whole 08:00-17:00 day, so each day has exactly one possible slot.
    const world = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      durationMinutes: 540,
    });
    await api.book(bookingBody(world, monday('08:00')));

    const { alternatives } = await conflictFor(world, monday('08:00'));

    // Tue, Wed, Thu, Fri, then the weekend is closed, then Monday the 11th: 5 slots, 7 days ahead included.
    expect(alternatives.map((a) => day(a.startTime))).toEqual([
      '2030-03-05',
      '2030-03-06',
      '2030-03-07',
      '2030-03-08',
      '2030-03-11',
    ]);
    expect(alternatives.every((a) => time(a.startTime) === '08:00')).toBe(true);
  });

  it('looks 7 days ahead and no further', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      durationMinutes: 540,
    });
    // Fill the requested day (Mon 4th) and every open day up to and including Mon 11th (day +7).
    for (const d of ['04', '05', '06', '07', '08', '11']) {
      expect((await api.book(bookingBody(world, `2030-03-${d}T08:00:00.000Z`))).statusCode).toBe(
        201,
      );
    }
    const { alternatives } = await conflictFor(world, monday('08:00'));
    // Tuesday the 12th is day +8, outside the window, so there is nothing to offer.
    expect(alternatives).toEqual([]);
  });

  it('always includes the alternatives field on a capacity conflict, empty when nothing is free', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      durationMinutes: 540,
    });
    for (const d of ['04', '05', '06', '07', '08', '11'])
      await api.book(bookingBody(world, `2030-03-${d}T08:00:00.000Z`));
    const body = await conflictFor(world, monday('08:00'));
    expect(Array.isArray(body.alternatives)).toBe(true);
  });

  it('only offers slots that can really be booked', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.book(bookingBody(world, monday('09:00')));
    const { alternatives } = await conflictFor(world, monday('09:00'));
    for (const alt of alternatives) {
      await testDb.db.deleteFrom('appointment').where('idempotency_key', 'like', 'alt-%').execute();
      const res = await api.book(bookingBody(world, alt.startTime), `alt-${alt.startTime}-key`);
      expect(res.statusCode, `alternative ${alt.startTime}`).toBe(201);
    }
  });

  it("uses only the requested dealership's capacity (another dealership having room does not help)", async () => {
    const a = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      durationMinutes: 540,
    });
    await createWorld(testDb.db, {
      withHours: true,
      bays: 3,
      technicians: 3,
      sharedWith: a,
      durationMinutes: 540,
    });
    await api.book(bookingBody(a, monday('08:00')));
    const { alternatives } = await conflictFor(a, monday('08:00'));
    expect(alternatives.length).toBeGreaterThan(0);
    expect(day(alternatives[0]!.startTime)).toBe('2030-03-05'); // a later day, not the same day elsewhere
  });

  it('is not offered for errors that are not about capacity', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('07:00')));
    expect(res.statusCode).toBe(422);
    expect(res.json()).not.toHaveProperty('alternatives');
  });

  it('never offers a slot in the past', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.book(bookingBody(world, monday('09:00')));
    api.setNow(new Date('2030-03-04T09:30:00.000Z')); // 08:00 and 09:xx are now in the past
    const { alternatives } = await conflictFor(world, monday('09:45')); // still overlaps the 09:00-10:00 booking
    expect(
      alternatives.every(
        (a) => new Date(a.startTime).getTime() > Date.parse('2030-03-04T09:30:00.000Z'),
      ),
    ).toBe(true);
    expect(time(alternatives[0]!.startTime)).toBe('10:00');
  });
});
