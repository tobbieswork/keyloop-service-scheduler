import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  blockBody,
  bookingBody,
  monday,
  startApi,
  type TestApi,
} from '../integration/helpers/api.js';
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

describe.each([
  ['bay', '/bays/{id}/unavailability'],
  ['technician', '/technicians/{id}/unavailability'],
] as const)('POST %s unavailability matches the contract', (kind, path) => {
  const op = { method: 'POST', path } as const;
  const idOf = (w: Awaited<ReturnType<typeof createWorld>>) =>
    kind === 'bay' ? w.bayIds[0]! : w.technicianIds[0]!;

  it('201 created, 400 malformed, 404 unknown', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const created = await api.block(kind, idOf(world), blockBody('09:00', '10:00'));
    expect(created.statusCode).toBe(201);
    assertMatchesContract(created, op);

    const bad = await api.block(kind, idOf(world), {
      startTime: monday('10:00'),
      endTime: monday('09:00'),
      reason: 'x',
    });
    expect(bad.statusCode).toBe(400);
    assertMatchesContract(bad, op);

    const unknown = await api.block(
      kind,
      '99999999-9999-4999-8999-999999999999',
      blockBody('09:00', '10:00'),
    );
    expect(unknown.statusCode).toBe(404);
    assertMatchesContract(unknown, op);
  });

  it('409 for both kinds of overlap', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.block(kind, idOf(world), blockBody('13:00', '14:00'));
    const overlapBlock = await api.block(kind, idOf(world), blockBody('13:30', '15:00'));
    expect(overlapBlock.statusCode).toBe(409);
    expect(overlapBlock.json().error.code).toBe('UNAVAILABILITY_OVERLAP');
    assertMatchesContract(overlapBlock, op);

    await api.book(bookingBody(world, monday('09:00')));
    const overlapAppointment = await api.block(kind, idOf(world), blockBody('09:30', '10:30'));
    expect(overlapAppointment.statusCode).toBe(409);
    expect(overlapAppointment.json().error.code).toBe('RESOURCE_HAS_APPOINTMENTS');
    assertMatchesContract(overlapAppointment, op);
  });
});
