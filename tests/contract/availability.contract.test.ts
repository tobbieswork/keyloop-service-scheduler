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

describe('GET /availability matches the contract', () => {
  it('200 with slots, 200 empty, 404 and 400', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    await api.book(bookingBody(world, monday('09:00')));
    const q = { dealershipId: world.dealershipId, serviceTypeId: world.serviceTypeId };
    const op = { method: 'GET', path: '/availability' } as const;

    const slots = await api.availability({ ...q, date: '2030-03-04' });
    expect(slots.statusCode).toBe(200);
    expect(slots.json().slots.length).toBeGreaterThan(0);
    assertMatchesContract(slots, op);

    const empty = await api.availability({ ...q, date: '2030-03-03' });
    expect(empty.json().slots).toEqual([]);
    assertMatchesContract(empty, op);

    const missing = await api.availability({
      ...q,
      dealershipId: '99999999-9999-4999-8999-999999999999',
      date: '2030-03-04',
    });
    expect(missing.statusCode).toBe(404);
    assertMatchesContract(missing, op);

    const bad = await api.availability({ ...q, date: 'nope' });
    expect(bad.statusCode).toBe(400);
    assertMatchesContract(bad, op);
  });
});

describe('reference endpoints match the contract', () => {
  it('GET /dealerships and GET /service-types', async () => {
    await createWorld(testDb.db, { withHours: true });
    const dealerships = await api.get('/dealerships');
    expect(dealerships.statusCode).toBe(200);
    assertMatchesContract(dealerships, { method: 'GET', path: '/dealerships' });

    const serviceTypes = await api.get('/service-types');
    expect(serviceTypes.statusCode).toBe(200);
    assertMatchesContract(serviceTypes, { method: 'GET', path: '/service-types' });
  });
});
