import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb, type TestDb } from './helpers/db.js';
import { createWorld } from './helpers/fixtures.js';
import { bookingBody, monday, newKey, startApi, NOW, type TestApi } from './helpers/api.js';

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

const appointmentCount = async () => {
  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM appointment`.execute(
    testDb.db,
  );
  return Number(rows[0]?.n);
};

describe('idempotency keys (FR-016)', () => {
  it('returns the original appointment when the same key and body are sent again', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const key = newKey();
    const first = await api.book(bookingBody(world, monday('09:00')), key);
    const again = await api.book(bookingBody(world, monday('09:00')), key);

    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await appointmentCount()).toBe(1);
  });

  it('treats the same instant written with a different offset as the same request', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const key = newKey();
    const first = await api.book(bookingBody(world, '2030-03-04T09:00:00.000Z'), key);
    const again = await api.book(bookingBody(world, '2030-03-04T10:00:00+01:00'), key);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    expect(await appointmentCount()).toBe(1);
  });

  it('rejects the same key with a different body (422 IDEMPOTENCY_KEY_REUSED)', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const key = newKey();
    await api.book(bookingBody(world, monday('09:00')), key);
    const different = await api.book(bookingBody(world, monday('11:00')), key);
    expect(different.statusCode).toBe(422);
    expect(different.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await appointmentCount()).toBe(1);
  });

  it('also rejects the same key when only the customer differs', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const other = await createWorld(testDb.db, { withHours: true });
    const key = newKey();
    await api.book(bookingBody(world, monday('09:00')), key);
    const res = await api.book(
      bookingBody(world, monday('09:00'), { customerId: other.customerId }),
      key,
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('stores nothing on a 409, so the same key can be retried once capacity frees up', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.book(bookingBody(world, monday('09:00')), 'first-booking-key');

    const retryKey = 'second-booking-key';
    const rejected = await api.book(bookingBody(world, monday('09:00')), retryKey);
    expect(rejected.statusCode).toBe(409);
    expect(await appointmentCount()).toBe(1);

    // The first appointment is cancelled, so the slot frees up.
    await testDb.db
      .updateTable('appointment')
      .set({ status: 'cancelled' })
      .where('idempotency_key', '=', 'first-booking-key')
      .execute();

    const retried = await api.book(bookingBody(world, monday('09:00')), retryKey);
    expect(retried.statusCode).toBe(201);
  });

  it('replaying a key after the appointment was cancelled returns the cancelled record, never a new booking', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const key = newKey();
    const first = (await api.book(bookingBody(world, monday('09:00')), key)).json();
    await testDb.db
      .updateTable('appointment')
      .set({ status: 'cancelled', cancelled_at: new Date() })
      .where('id', '=', first.id)
      .execute();

    const again = await api.book(bookingBody(world, monday('09:00')), key);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.id);
    expect(again.json().status).toBe('cancelled');
    expect(await appointmentCount()).toBe(1);
  });

  it('still replays after the start time has passed (the replay does not re-check the clock)', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const key = newKey();
    const first = (await api.book(bookingBody(world, monday('09:00')), key)).json();
    api.setNow(new Date('2030-03-10T00:00:00.000Z')); // the appointment is now in the past
    const again = await api.book(bookingBody(world, monday('09:00')), key);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.id);
  });

  it('gives different keys independent bookings', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    const a = await api.book(bookingBody(world, monday('09:00')), newKey());
    const b = await api.book(bookingBody(world, monday('09:00')), newKey());
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
  });
});
