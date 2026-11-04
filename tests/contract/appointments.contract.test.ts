import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, monday, startApi, type TestApi } from '../integration/helpers/api.js';
import { startTestDb, type TestDb } from '../integration/helpers/db.js';
import { createWorld } from '../integration/helpers/fixtures.js';
import { assertMatchesContract } from './helpers.js';

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

const post = (res: LightMyRequestResponse) =>
  assertMatchesContract(res, { method: 'POST', path: '/appointments' });
const get = (res: LightMyRequestResponse) =>
  assertMatchesContract(res, { method: 'GET', path: '/appointments/{id}' });

describe('POST /appointments matches the contract', () => {
  it('201 created', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:00')));
    expect(res.statusCode).toBe(201);
    post(res);
  });

  it('200 replay', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    await api.book(bookingBody(world, monday('09:00')), 'contract-key-1');
    const res = await api.book(bookingBody(world, monday('09:00')), 'contract-key-1');
    expect(res.statusCode).toBe(200);
    post(res);
  });

  it('400 malformed request', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:00'), { customerId: 'nope' }));
    expect(res.statusCode).toBe(400);
    post(res);
  });

  it('404 unknown reference', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(
      bookingBody(world, monday('09:00'), { dealershipId: '99999999-9999-4999-8999-999999999999' }),
    );
    expect(res.statusCode).toBe(404);
    post(res);
  });

  it('409 no capacity', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.book(bookingBody(world, monday('09:00')));
    const res = await api.book(bookingBody(world, monday('09:00')));
    expect(res.statusCode).toBe(409);
    post(res);
  });

  it.each([
    ['OUTSIDE_WORKING_HOURS', monday('07:00'), {}],
    ['START_IN_PAST', '2030-02-26T09:00:00.000Z', {}],
  ])('422 %s', async (code, start, overrides) => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, start, overrides));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe(code);
    post(res);
  });

  it('422 VEHICLE_CUSTOMER_MISMATCH', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const other = await createWorld(testDb.db, { withHours: true });
    const res = await api.book(bookingBody(world, monday('09:00'), { vehicleId: other.vehicleId }));
    expect(res.statusCode).toBe(422);
    post(res);
  });

  it('422 IDEMPOTENCY_KEY_REUSED', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    await api.book(bookingBody(world, monday('09:00')), 'contract-key-2');
    const res = await api.book(bookingBody(world, monday('11:00')), 'contract-key-2');
    expect(res.statusCode).toBe(422);
    post(res);
  });
});

describe('GET /appointments/{id} matches the contract', () => {
  it('200 found, 404 unknown, 400 malformed', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const created = (await api.book(bookingBody(world, monday('09:00')))).json();
    const found = await api.getAppointment(created.id);
    expect(found.statusCode).toBe(200);
    get(found);

    const unknown = await api.getAppointment('99999999-9999-4999-8999-999999999999');
    expect(unknown.statusCode).toBe(404);
    get(unknown);

    const malformed = await api.getAppointment('not-a-uuid');
    expect(malformed.statusCode).toBe(400);
    get(malformed);
  });
});
