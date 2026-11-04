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

const MONDAY = '2030-03-04';
const slotsFor = async (world: World, date = MONDAY) => {
  const res = await api.availability({
    dealershipId: world.dealershipId,
    serviceTypeId: world.serviceTypeId,
    date,
  });
  expect(res.statusCode).toBe(200);
  return (res.json().slots as { startTime: string; endTime: string }[]).map((s) =>
    s.startTime.slice(11, 16),
  );
};

describe('GET /availability (FR-010)', () => {
  it('lists every 15-minute start on an open day', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const slots = await slotsFor(world);
    expect(slots[0]).toBe('08:00');
    expect(slots.at(-1)).toBe('16:00');
    expect(slots).toHaveLength(33);
  });

  it('gives each slot an end that includes the buffer', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      durationMinutes: 45,
      bufferMinutes: 15,
    });
    const res = await api.availability({
      dealershipId: world.dealershipId,
      serviceTypeId: world.serviceTypeId,
      date: MONDAY,
    });
    expect(res.json().slots[0]).toEqual({
      startTime: '2030-03-04T08:00:00.000Z',
      endTime: '2030-03-04T09:00:00.000Z',
    });
  });

  it('removes booked times, keeping the back-to-back starts either side', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.book(bookingBody(world, monday('09:00')));
    const slots = await slotsFor(world);
    expect(slots).toContain('08:00');
    expect(slots).not.toContain('08:15');
    expect(slots).not.toContain('09:00');
    expect(slots).not.toContain('09:45');
    expect(slots).toContain('10:00');
  });

  it('keeps a time open while any bay and technician pair is still free', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    await api.book(bookingBody(world, monday('09:00')));
    expect(await slotsFor(world)).toContain('09:00');
    await api.book(bookingBody(world, monday('09:00')));
    expect(await slotsFor(world)).not.toContain('09:00');
  });

  it('puts cancelled appointments back (they no longer block)', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const created = (await api.book(bookingBody(world, monday('09:00')))).json();
    expect(await slotsFor(world)).not.toContain('09:00');
    await testDb.db
      .updateTable('appointment')
      .set({ status: 'cancelled' })
      .where('id', '=', created.id)
      .execute();
    expect(await slotsFor(world)).toContain('09:00');
  });

  it('returns an empty list, not an error, on a closed day and when nobody is qualified', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const sunday = await api.availability({
      dealershipId: world.dealershipId,
      serviceTypeId: world.serviceTypeId,
      date: '2030-03-03',
    });
    expect(sunday.statusCode).toBe(200);
    expect(sunday.json()).toEqual({ slots: [] });

    const unstaffed = await createWorld(testDb.db, {
      withHours: true,
      technicians: 0,
      unqualifiedTechnicians: 2,
    });
    expect(await slotsFor(unstaffed)).toEqual([]);
  });

  it('offers nothing when the only technicians hold a different skill', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      technicians: 0,
      unqualifiedTechnicians: 3,
    });
    expect(await slotsFor(world)).toEqual([]);
  });

  it('offers nothing when the dealership has no bays of its own, even if another dealership has bays', async () => {
    const a = await createWorld(testDb.db, { withHours: true, bays: 0, technicians: 2 });
    await createWorld(testDb.db, { withHours: true, bays: 3, technicians: 0, sharedWith: a });
    expect(await slotsFor(a)).toEqual([]);
  });

  it('offers nothing when the dealership has no qualified technicians of its own, even if another dealership does', async () => {
    const a = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 0 });
    await createWorld(testDb.db, { withHours: true, bays: 0, technicians: 3, sharedWith: a });
    expect(await slotsFor(a)).toEqual([]);
  });

  it('shows only slots in the future', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    api.setNow(new Date('2030-03-04T12:00:00.000Z'));
    const slots = await slotsFor(world);
    expect(slots[0]).toBe('12:15'); // 12:00 is not in the future
  });

  it('uses the dealership time zone (New York: 08:00 EST is 13:00Z)', async () => {
    const world = await createWorld(testDb.db, { withHours: true, timeZone: 'America/New_York' });
    const res = await api.availability({
      dealershipId: world.dealershipId,
      serviceTypeId: world.serviceTypeId,
      date: MONDAY,
    });
    expect(res.json().slots[0].startTime).toBe('2030-03-04T13:00:00.000Z');
  });

  it('is not affected by bookings at another dealership', async () => {
    const a = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const b = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      sharedWith: a,
    });
    await api.book(bookingBody(b, monday('09:00')));
    expect(await slotsFor(a)).toContain('09:00');
    expect(await slotsFor(b)).not.toContain('09:00');
  });

  it('offers fewer slots for a longer service', async () => {
    const short = await createWorld(testDb.db, { withHours: true, durationMinutes: 60 });
    const long = await createWorld(testDb.db, { withHours: true, durationMinutes: 180 });
    expect((await slotsFor(long)).length).toBeLessThan((await slotsFor(short)).length);
    expect((await slotsFor(long)).at(-1)).toBe('14:00'); // 14:00 + 180 min ends at 17:00
  });
});

describe('availability and booking always agree', () => {
  // The most important property: a start that availability lists can be booked, and one it
  // leaves out cannot. Each case rebuilds the same situation so one booking never affects another.
  const probes = [
    '08:00',
    '08:15',
    '08:45',
    '09:00',
    '09:45',
    '10:00',
    '10:15',
    '16:00',
    '16:15',
    '07:45',
  ];

  it.each(probes)('start %s', async (time) => {
    await testDb.reset();
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.book(bookingBody(world, monday('09:00'))); // an existing 09:00-10:00 booking

    const listed = (await slotsFor(world)).includes(time);
    const res = await api.book(bookingBody(world, monday(time)));
    expect(
      res.statusCode === 201,
      `availability says ${listed}, booking returned ${res.statusCode}`,
    ).toBe(listed);
  });

  it('agrees when buffers and several resources are involved', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      bays: 2,
      technicians: 2,
      durationMinutes: 45,
      bufferMinutes: 15,
    });
    await api.book(bookingBody(world, monday('09:00')));
    await api.book(bookingBody(world, monday('09:30')));
    const listed = new Set(await slotsFor(world));
    for (const time of ['08:15', '09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30']) {
      await testDb.db
        .deleteFrom('appointment')
        .where('idempotency_key', 'like', 'probe-%')
        .execute();
      const res = await api.book(bookingBody(world, monday(time)), `probe-${time}-key`);
      expect(
        res.statusCode === 201,
        `${time}: availability says ${listed.has(time)}, booking ${res.statusCode}`,
      ).toBe(listed.has(time));
    }
  });
});

describe('GET /availability: bad requests', () => {
  it('404 for an unknown dealership or service type', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const missing = '99999999-9999-4999-8999-999999999999';
    expect(
      (
        await api.availability({
          dealershipId: missing,
          serviceTypeId: world.serviceTypeId,
          date: MONDAY,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api.availability({
          dealershipId: world.dealershipId,
          serviceTypeId: missing,
          date: MONDAY,
        })
      ).statusCode,
    ).toBe(404);
  });

  it.each([
    ['an impossible date', '2030-02-30'],
    ['a wrong format', '04/03/2030'],
    ['a date with a time', '2030-03-04T09:00:00Z'],
  ])('400 for %s', async (_name, date) => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.availability({
      dealershipId: world.dealershipId,
      serviceTypeId: world.serviceTypeId,
      date,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('400 for missing or malformed parameters', async () => {
    expect((await api.get('/availability')).statusCode).toBe(400);
    expect(
      (await api.get('/availability?dealershipId=nope&serviceTypeId=nope&date=2030-03-04'))
        .statusCode,
    ).toBe(400);
  });
});

describe('reference data for clients', () => {
  it('GET /dealerships lists id, name and time zone', async () => {
    const a = await createWorld(testDb.db, { timeZone: 'Europe/London' });
    await createWorld(testDb.db, { timeZone: 'America/New_York', sharedWith: a });
    const res = await api.get('/dealerships');
    expect(res.statusCode).toBe(200);
    const list = res.json() as { id: string; name: string; timeZone: string }[];
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.timeZone).sort()).toEqual(['America/New_York', 'Europe/London']);
    expect(list.every((d) => d.id && d.name)).toBe(true);
  });

  it('GET /service-types lists id, name, duration and buffer', async () => {
    const world = await createWorld(testDb.db, { durationMinutes: 45, bufferMinutes: 15 });
    const res = await api.get('/service-types');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: world.serviceTypeId,
        name: 'SAMPLE brake service',
        durationMinutes: 45,
        bufferMinutes: 15,
      },
    ]);
  });

  it('both return an empty list, not an error, when there is nothing', async () => {
    expect((await api.get('/dealerships')).json()).toEqual([]);
    expect((await api.get('/service-types')).json()).toEqual([]);
  });
});
