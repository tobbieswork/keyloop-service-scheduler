import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, monday, newKey, NOW, startApi, type TestApi } from './helpers/api.js';
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

const bookOne = async (world: World, time = '09:00') => {
  const res = await api.book(bookingBody(world, monday(time)));
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; bayId: string; technicianId: string };
};

describe('POST /appointments/{id}/cancel (FR-013)', () => {
  it('cancels a confirmed appointment and returns it as cancelled with a timestamp', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const created = await bookOne(world);

    api.setNow(new Date('2030-03-02T10:30:00.000Z'));
    const res = await api.cancel(created.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: created.id,
      status: 'cancelled',
      cancelledAt: '2030-03-02T10:30:00.000Z',
    });
  });

  it('frees the bay and technician: the same slot can be booked again', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const created = await bookOne(world);
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(409);

    await api.cancel(created.id);

    const rebooked = await api.book(bookingBody(world, monday('09:00')));
    expect(rebooked.statusCode).toBe(201);
    expect(rebooked.json().id).not.toBe(created.id);
    expect(rebooked.json().bayId).toBe(created.bayId); // the same place, now free
  });

  it('puts the slot back into availability', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const created = await bookOne(world);
    const slots = async () =>
      (
        (
          await api.availability({
            dealershipId: world.dealershipId,
            serviceTypeId: world.serviceTypeId,
            date: '2030-03-04',
          })
        ).json().slots as { startTime: string }[]
      ).map((s) => s.startTime.slice(11, 16));
    expect(await slots()).not.toContain('09:00');
    await api.cancel(created.id);
    expect(await slots()).toContain('09:00');
  });

  it('keeps the cancelled record: it can still be retrieved, shown as cancelled', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const created = await bookOne(world);
    await api.cancel(created.id);

    const res = await api.getAppointment(created.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: created.id, status: 'cancelled' });
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM appointment`.execute(
      testDb.db,
    );
    expect(Number(rows[0]?.n)).toBe(1); // nothing was deleted
  });

  it('is idempotent: cancelling twice returns the same record, with the FIRST cancellation time', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const created = await bookOne(world);

    api.setNow(new Date('2030-03-02T10:00:00.000Z'));
    const first = (await api.cancel(created.id)).json();
    api.setNow(new Date('2030-03-02T11:00:00.000Z'));
    const second = await api.cancel(created.id);

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first);
    expect(second.json().cancelledAt).toBe('2030-03-02T10:00:00.000Z');
  });

  it('leaves other appointments untouched', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    const a = await bookOne(world, '09:00');
    const b = await bookOne(world, '09:00');
    await api.cancel(a.id);
    expect((await api.getAppointment(b.id)).json().status).toBe('confirmed');
  });

  it('survives ten simultaneous cancels of the same appointment: all succeed, one cancellation time', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const created = await bookOne(world);

    const responses = await Promise.all(Array.from({ length: 10 }, () => api.cancel(created.id)));

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.json().cancelledAt)).size).toBe(1);
  });

  it('a replayed booking key returns the cancelled record and never re-books', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const key = newKey();
    const created = (await api.book(bookingBody(world, monday('09:00')), key)).json();
    await api.cancel(created.id);

    const replay = await api.book(bookingBody(world, monday('09:00')), key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: created.id, status: 'cancelled' });
  });

  it('returns 404 for an unknown appointment and 400 for a malformed ID', async () => {
    const unknown = await api.cancel('99999999-9999-4999-8999-999999999999');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
    expect((await api.cancel('not-a-uuid')).statusCode).toBe(400);
  });

  it('a cancel and a rebook racing for the same place never double-book', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const created = await bookOne(world);

    const [cancel, rebook] = await Promise.all([
      api.cancel(created.id),
      api.book(bookingBody(world, monday('09:00'))),
    ]);

    expect(cancel.statusCode).toBe(200);
    // The rebook either ran before the cancel committed (409) or after it (201). Both are correct.
    expect([201, 409]).toContain(rebook.statusCode);
    const { rows } = await sql<{
      n: string;
    }>`SELECT count(*)::text AS n FROM appointment WHERE status = 'confirmed'`.execute(testDb.db);
    expect(Number(rows[0]?.n)).toBe(rebook.statusCode === 201 ? 1 : 0);
  });
});
