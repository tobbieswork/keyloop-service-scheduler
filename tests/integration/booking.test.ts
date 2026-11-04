import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb, type TestDb } from './helpers/db.js';
import { createWorld, type World } from './helpers/fixtures.js';
import { bookingBody, monday, startApi, type TestApi } from './helpers/api.js';

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

const appointmentCount = async () => {
  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM appointment`.execute(
    testDb.db,
  );
  return Number(rows[0]?.n);
};
const lowest = (ids: string[]) => [...ids].sort()[0]!;
const highest = (ids: string[]) => [...ids].sort().at(-1)!;

describe('POST /appointments: success (US1, FR-001..FR-006)', () => {
  it('confirms a booking and links customer, vehicle, bay and technician', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:00')));
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({
      customerId: world.customerId,
      vehicleId: world.vehicleId,
      serviceTypeId: world.serviceTypeId,
      dealershipId: world.dealershipId,
      status: 'confirmed',
      cancelledAt: null,
    });
    expect(world.bayIds).toContain(a.bayId);
    expect(world.technicianIds).toContain(a.technicianId);
    expect(await appointmentCount()).toBe(1);
  });

  it('reports start, service end and occupied-until, with the buffer counted only in the last (FR-002)', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      durationMinutes: 45,
      bufferMinutes: 15,
    });
    const a = (await api.book(bookingBody(world, monday('09:00')))).json();
    expect(a.startTime).toBe('2030-03-04T09:00:00.000Z');
    expect(a.serviceEndTime).toBe('2030-03-04T09:45:00.000Z');
    expect(a.occupiedUntil).toBe('2030-03-04T10:00:00.000Z');
  });

  it('can be read back with customer, vehicle, technician and bay (SC-004)', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const created = (await api.book(bookingBody(world, monday('09:00')))).json();
    const res = await api.getAppointment(created.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
  });

  it('uses the dealership time zone: 09:00 in New York (UTC-5 in March) is 14:00Z', async () => {
    const world = await createWorld(testDb.db, { withHours: true, timeZone: 'America/New_York' });
    const res = await api.book(bookingBody(world, '2030-03-04T09:00:00-05:00'));
    expect(res.statusCode).toBe(201);
    expect(res.json().startTime).toBe('2030-03-04T14:00:00.000Z');
  });
});

describe('POST /appointments: capacity (FR-003, FR-004, FR-008)', () => {
  it('rejects with 409 when no bay is free, and stores nothing extra', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 2 });
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(201);
    const res = await api.book(bookingBody(world, monday('09:30')));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SLOT_UNAVAILABLE');
    expect(await appointmentCount()).toBe(1);
  });

  it('rejects with 409 when no technician is free', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 1 });
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(201);
    const res = await api.book(bookingBody(world, monday('09:30')));
    expect(res.statusCode).toBe(409);
    expect(await appointmentCount()).toBe(1);
  });

  it('rejects with 409 when nobody holds the required skill', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      technicians: 0,
      unqualifiedTechnicians: 2,
    });
    const res = await api.book(bookingBody(world, monday('09:00')));
    expect(res.statusCode).toBe(409);
    expect(await appointmentCount()).toBe(0);
  });

  it('never assigns an unqualified technician, even when the qualified one is busy', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      bays: 3,
      technicians: 1,
      unqualifiedTechnicians: 2,
    });
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(201);
    const second = await api.book(bookingBody(world, monday('09:00')));
    expect(second.statusCode).toBe(409);
    const { rows } = await sql<{
      technician_id: string;
    }>`SELECT technician_id FROM appointment`.execute(testDb.db);
    expect(rows.every((r) => world.technicianIds.includes(r.technician_id))).toBe(true);
  });

  it('only uses resources from the requested dealership (another dealership having room does not help)', async () => {
    const a = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await createWorld(testDb.db, { withHours: true, bays: 5, technicians: 5 }); // lots of room elsewhere
    expect((await api.book(bookingBody(a, monday('09:00')))).statusCode).toBe(201);
    const res = await api.book(bookingBody(a, monday('09:00')));
    expect(res.statusCode).toBe(409);
  });

  it('never gives a booking a bay from another dealership, even when technicians are plentiful', async () => {
    // Dealership A has 1 bay and 3 technicians. Dealership B has 5 bays. After A's only bay is
    // taken, a second booking must fail: B's free bays are not A's to use.
    const a = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 3 });
    await createWorld(testDb.db, { withHours: true, bays: 5, technicians: 0, sharedWith: a });
    expect((await api.book(bookingBody(a, monday('09:00')))).statusCode).toBe(201);
    expect((await api.book(bookingBody(a, monday('09:00')))).statusCode).toBe(409);
  });

  it('never gives a booking a technician from another dealership, even when they hold the same skill', async () => {
    const a = await createWorld(testDb.db, { withHours: true, bays: 3, technicians: 1 });
    await createWorld(testDb.db, { withHours: true, bays: 0, technicians: 5, sharedWith: a });
    expect((await api.book(bookingBody(a, monday('09:00')))).statusCode).toBe(201);
    expect((await api.book(bookingBody(a, monday('09:00')))).statusCode).toBe(409);
  });

  it('accepts a booking that ends exactly when an existing one starts (back-to-back, earlier slot booked second)', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    expect((await api.book(bookingBody(world, monday('10:00')))).statusCode).toBe(201);
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(201);
  });

  it('accepts back-to-back appointments: the next starts when the previous ends (FR-005)', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(201);
    expect((await api.book(bookingBody(world, monday('10:00')))).statusCode).toBe(201);
  });

  it('counts the buffer: with 45 min + 15 min buffer, 09:45 clashes but 10:00 does not', async () => {
    const world = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      durationMinutes: 45,
      bufferMinutes: 15,
    });
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(201);
    expect((await api.book(bookingBody(world, monday('09:45')))).statusCode).toBe(409);
    expect((await api.book(bookingBody(world, monday('10:00')))).statusCode).toBe(201);
  });

  it('assigns the least-booked bay and technician that day, ties to the lowest ID (FR-017)', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    const first = (await api.book(bookingBody(world, monday('09:00')))).json();
    expect(first.bayId).toBe(lowest(world.bayIds));
    expect(first.technicianId).toBe(lowest(world.technicianIds));

    // Now the lowest-ID resources have 1 booking and the others have 0, so the others are chosen.
    const second = (await api.book(bookingBody(world, monday('11:00')))).json();
    expect(second.bayId).toBe(highest(world.bayIds));
    expect(second.technicianId).toBe(highest(world.technicianIds));

    // Everyone has 1 booking again: back to the lowest ID.
    const third = (await api.book(bookingBody(world, monday('13:00')))).json();
    expect(third.bayId).toBe(lowest(world.bayIds));
    expect(third.technicianId).toBe(lowest(world.technicianIds));
  });
});

describe('POST /appointments: business rules (FR-011)', () => {
  it.each([
    ['before opening (07:45)', '07:45'],
    ['running past closing (16:30 + 60 min)', '16:30'],
    ['after closing (17:00)', '17:00'],
  ])('rejects a start %s with 422 OUTSIDE_WORKING_HOURS', async (_name, time) => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday(time)));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('OUTSIDE_WORKING_HOURS');
    expect(await appointmentCount()).toBe(0);
  });

  it('rejects a closed day (Sunday) and says why', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, '2030-03-03T10:00:00.000Z'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('OUTSIDE_WORKING_HOURS');
    expect(res.json().error.details).toEqual({ reason: 'CLOSED_DAY' });
  });

  it('rejects a start that is not on a 15-minute boundary', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:10')));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toEqual({ reason: 'NOT_ALIGNED' });
  });

  it('uses the dealership zone for hours: 07:30 New York time is too early', async () => {
    const world = await createWorld(testDb.db, { withHours: true, timeZone: 'America/New_York' });
    const res = await api.book(bookingBody(world, '2030-03-04T07:30:00-05:00'));
    expect(res.statusCode).toBe(422);
  });

  it('rejects a start in the past with 422 START_IN_PAST', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, '2030-02-26T09:00:00.000Z'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('START_IN_PAST');
  });

  it('reports "in the past" before "outside hours" when both apply', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, '2030-02-24T10:00:00.000Z')); // a past Sunday
    expect(res.json().error.code).toBe('START_IN_PAST');
  });

  it('rejects a vehicle that belongs to another customer with 422', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const other = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:00'), { vehicleId: other.vehicleId }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VEHICLE_CUSTOMER_MISMATCH');
    expect(await appointmentCount()).toBe(0);
  });
});

describe('POST /appointments: unknown references give 404', () => {
  const missing = '99999999-9999-4999-8999-999999999999';
  it.each([
    ['dealershipId', 'dealership'],
    ['serviceTypeId', 'service type'],
    ['customerId', 'customer'],
    ['vehicleId', 'vehicle'],
  ])('unknown %s', async (field, label) => {
    const world: World = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:00'), { [field]: missing }));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.json().error.message).toContain(label);
    expect(await appointmentCount()).toBe(0);
  });
});

describe('POST /appointments: malformed input gives 400 (FR-012)', () => {
  it.each([
    ['a bad customer UUID', { customerId: 'nope' }],
    ['a bad date', { startTime: 'tomorrow morning' }],
    ['a date without a time zone offset', { startTime: '2030-03-04T09:00:00' }],
    ['a missing field', { vehicleId: undefined }],
  ])('rejects %s', async (_name, override) => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:00'), override));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await appointmentCount()).toBe(0);
  });

  it('rejects a missing Idempotency-Key header', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:00')), null);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error.details)).toContain('idempotency-key');
  });

  it('rejects an Idempotency-Key that is too short or too long', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    expect((await api.book(bookingBody(world, monday('09:00')), 'short')).statusCode).toBe(400);
    expect((await api.book(bookingBody(world, monday('09:00')), 'x'.repeat(129))).statusCode).toBe(
      400,
    );
  });
});

describe('GET /appointments/{id}', () => {
  it('returns 404 for an unknown ID and 400 for a malformed one', async () => {
    expect((await api.getAppointment('99999999-9999-4999-8999-999999999999')).statusCode).toBe(404);
    expect((await api.getAppointment('not-a-uuid')).statusCode).toBe(400);
  });
});
