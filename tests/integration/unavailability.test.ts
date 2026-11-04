import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blockBody, bookingBody, monday, NOW, startApi, type TestApi } from './helpers/api.js';
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

const kinds = ['bay', 'technician'] as const;
/**
 * A resource of the world. Index 0 is the one that booking would pick FIRST (lowest ID wins ties),
 * index 1 the next. Blocking index 0 is what makes a test meaningful: blocking a resource that
 * would not have been chosen anyway proves nothing.
 */
const resourceId = (world: World, kind: (typeof kinds)[number], index = 0) =>
  [...(kind === 'bay' ? world.bayIds : world.technicianIds)].sort()[index]!;
const blockCount = async () => {
  const { rows } = await sql<{ n: string }>`
    SELECT ((SELECT count(*) FROM bay_unavailability) + (SELECT count(*) FROM technician_unavailability))::text AS n`.execute(
    testDb.db,
  );
  return Number(rows[0]?.n);
};
const slots = async (world: World) =>
  (
    (
      await api.availability({
        dealershipId: world.dealershipId,
        serviceTypeId: world.serviceTypeId,
        date: '2030-03-04',
      })
    ).json().slots as { startTime: string }[]
  ).map((s) => s.startTime.slice(11, 16));

describe.each(kinds)('blocking a %s (FR-015, US5)', (kind) => {
  it('creates the block and returns it', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.block(
      kind,
      resourceId(world, kind),
      blockBody('09:00', '12:00', 'SAMPLE leave'),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      resourceId: resourceId(world, kind),
      startTime: '2030-03-04T09:00:00.000Z',
      endTime: '2030-03-04T12:00:00.000Z',
      reason: 'SAMPLE leave',
    });
    expect(res.json().id).toBeTruthy();
  });

  it('is never assigned while blocked: bookings use the other resource, then are refused', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    await api.block(kind, resourceId(world, kind, 0), blockBody('09:00', '12:00'));

    const first = await api.book(bookingBody(world, monday('09:00')));
    expect(first.statusCode).toBe(201);
    const usedByFirst = kind === 'bay' ? first.json().bayId : first.json().technicianId;
    expect(usedByFirst).toBe(resourceId(world, kind, 1)); // the blocked one was skipped

    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(409);
  });

  it('is available again outside the blocked time, including exactly when the block ends or starts', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.block(kind, resourceId(world, kind), blockBody('09:00', '10:00'));
    expect((await api.book(bookingBody(world, monday('08:00')))).statusCode).toBe(201); // ends as the block starts
    expect((await api.book(bookingBody(world, monday('10:00')))).statusCode).toBe(201); // starts as the block ends
  });

  it('is removed from availability for the blocked time, like a booking', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.block(kind, resourceId(world, kind), blockBody('09:00', '10:00'));
    const open = await slots(world);
    expect(open).toContain('08:00');
    expect(open).not.toContain('08:15');
    expect(open).not.toContain('09:45');
    expect(open).toContain('10:00');
  });

  it('keeps availability open when another resource can take the work', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    await api.block(kind, resourceId(world, kind, 0), blockBody('09:00', '10:00'));
    expect(await slots(world)).toContain('09:00');
  });

  it('is refused with 409 RESOURCE_HAS_APPOINTMENTS when it would overlap a confirmed appointment', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const booked = (await api.book(bookingBody(world, monday('09:00')))).json();

    const res = await api.block(kind, resourceId(world, kind), blockBody('09:30', '11:00'));

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RESOURCE_HAS_APPOINTMENTS');
    expect(await blockCount()).toBe(0);
    expect((await api.getAppointment(booked.id)).json().status).toBe('confirmed'); // untouched
  });

  it('is allowed next to an appointment (touching ends), and over a cancelled one', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const booked = (await api.book(bookingBody(world, monday('09:00')))).json();
    expect(
      (await api.block(kind, resourceId(world, kind), blockBody('10:00', '11:00'))).statusCode,
    ).toBe(201);

    await api.cancel(booked.id);
    expect(
      (await api.block(kind, resourceId(world, kind), blockBody('09:00', '10:00'))).statusCode,
    ).toBe(201);
  });

  it('is refused with 409 UNAVAILABILITY_OVERLAP when it overlaps an existing block on the same resource', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const id = resourceId(world, kind);
    expect((await api.block(kind, id, blockBody('09:00', '12:00'))).statusCode).toBe(201);

    const overlapping = await api.block(kind, id, blockBody('11:00', '13:00'));
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json().error.code).toBe('UNAVAILABILITY_OVERLAP');

    expect((await api.block(kind, id, blockBody('12:00', '13:00'))).statusCode).toBe(201); // adjacent is fine
    expect(await blockCount()).toBe(2);
  });

  it('is independent per resource: another resource can be blocked for the same time', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    expect(
      (await api.block(kind, resourceId(world, kind, 0), blockBody('09:00', '12:00'))).statusCode,
    ).toBe(201);
    expect(
      (await api.block(kind, resourceId(world, kind, 1), blockBody('09:00', '12:00'))).statusCode,
    ).toBe(201);
  });

  it('can be set for a time that has already started (someone called in sick this morning)', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    api.setNow(new Date('2030-03-04T10:00:00.000Z'));
    expect(
      (await api.block(kind, resourceId(world, kind), blockBody('08:00', '17:00'))).statusCode,
    ).toBe(201);
  });

  it('is a 404 for an unknown resource', async () => {
    const res = await api.block(
      kind,
      '99999999-9999-4999-8999-999999999999',
      blockBody('09:00', '10:00'),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it.each([
    [
      'an end before the start',
      { startTime: monday('10:00'), endTime: monday('09:00'), reason: 'x' },
    ],
    ['an empty period', { startTime: monday('10:00'), endTime: monday('10:00'), reason: 'x' }],
    ['a missing reason', { startTime: monday('09:00'), endTime: monday('10:00') }],
    ['an empty reason', { startTime: monday('09:00'), endTime: monday('10:00'), reason: '' }],
    [
      'a reason over 200 characters',
      { startTime: monday('09:00'), endTime: monday('10:00'), reason: 'x'.repeat(201) },
    ],
    [
      'a time without an offset',
      { startTime: '2030-03-04T09:00:00', endTime: monday('10:00'), reason: 'x' },
    ],
  ])('is a 400 for %s', async (_name, body) => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.block(kind, resourceId(world, kind), body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await blockCount()).toBe(0);
  });

  it('is a 400 for a malformed resource ID', async () => {
    expect((await api.block(kind, 'not-a-uuid', blockBody('09:00', '10:00'))).statusCode).toBe(400);
  });
});

describe.each(kinds)('listing and removing blocks of a %s', (kind) => {
  const other = kind === 'bay' ? 'technician' : 'bay';
  const make = async (
    world: World,
    index: number,
    from: string,
    to: string,
    reason = 'SAMPLE reason',
  ) => {
    const res = await api.block(kind, resourceId(world, kind, index), blockBody(from, to, reason));
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  };

  it("lists the resource's blocks, earliest first, with every field", async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const late = await make(world, 0, '14:00', '15:00', 'SAMPLE late');
    const early = await make(world, 0, '09:00', '10:00', 'SAMPLE early');

    const res = await api.listBlocks(kind, resourceId(world, kind, 0));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: early.id,
        resourceId: resourceId(world, kind, 0),
        startTime: '2030-03-04T09:00:00.000Z',
        endTime: '2030-03-04T10:00:00.000Z',
        reason: 'SAMPLE early',
      },
      {
        id: late.id,
        resourceId: resourceId(world, kind, 0),
        startTime: '2030-03-04T14:00:00.000Z',
        endTime: '2030-03-04T15:00:00.000Z',
        reason: 'SAMPLE late',
      },
    ]);
  });

  it('returns an empty list, not an error, when there are none', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const res = await api.listBlocks(kind, resourceId(world, kind));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("lists only that resource's own blocks", async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    const mine = await make(world, 0, '09:00', '10:00');
    await make(world, 1, '09:00', '10:00');
    const res = await api.listBlocks(kind, resourceId(world, kind, 0));
    expect((res.json() as { id: string }[]).map((b) => b.id)).toEqual([mine.id]);
  });

  it('removes a block (204, no body) and it disappears from the list', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const block = await make(world, 0, '09:00', '10:00');

    const res = await api.removeBlock(kind, resourceId(world, kind), block.id);

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await api.listBlocks(kind, resourceId(world, kind))).json()).toEqual([]);
  });

  it('gives the time back: booking and availability work again, and the period can be blocked anew', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const block = await make(world, 0, '09:00', '10:00');
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(409);
    expect(await slots(world)).not.toContain('09:00');

    await api.removeBlock(kind, resourceId(world, kind), block.id);

    expect(await slots(world)).toContain('09:00');
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(201);
    // The same period can be blocked again once it is free of appointments elsewhere in time.
    expect(
      (await api.block(kind, resourceId(world, kind), blockBody('11:00', '12:00'))).statusCode,
    ).toBe(201);
  });

  it('removing twice: the second time is a 404', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const block = await make(world, 0, '09:00', '10:00');
    expect((await api.removeBlock(kind, resourceId(world, kind), block.id)).statusCode).toBe(204);
    const again = await api.removeBlock(kind, resourceId(world, kind), block.id);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('NOT_FOUND');
  });

  it("cannot remove another resource's block through this resource, and leaves it in place", async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 2, technicians: 2 });
    const theirs = await make(world, 1, '09:00', '10:00');
    const res = await api.removeBlock(kind, resourceId(world, kind, 0), theirs.id);
    expect(res.statusCode).toBe(404);
    expect((await api.listBlocks(kind, resourceId(world, kind, 1))).json()).toHaveLength(1);
  });

  it(`cannot remove a ${other} block through a ${kind} URL`, async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const block = await api.block(other, resourceId(world, other), blockBody('09:00', '10:00'));
    const res = await api.removeBlock(kind, resourceId(world, kind), block.json().id);
    expect(res.statusCode).toBe(404);
    expect((await api.listBlocks(other, resourceId(world, other))).json()).toHaveLength(1);
  });

  it('is a 404 for an unknown resource or block, and a 400 for malformed IDs', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const missing = '99999999-9999-4999-8999-999999999999';
    expect((await api.listBlocks(kind, missing)).statusCode).toBe(404);
    expect((await api.removeBlock(kind, missing, missing)).statusCode).toBe(404);
    expect((await api.removeBlock(kind, resourceId(world, kind), missing)).statusCode).toBe(404);
    expect((await api.listBlocks(kind, 'nope')).statusCode).toBe(400);
    expect((await api.removeBlock(kind, 'nope', missing)).statusCode).toBe(400);
    expect((await api.removeBlock(kind, resourceId(world, kind), 'nope')).statusCode).toBe(400);
  });
});

describe('a block and the booking rules agree', () => {
  // The same cross-check as for plain bookings: whatever availability lists can be booked,
  // whatever it leaves out cannot, with a block in the picture.
  const probes = ['08:00', '08:15', '08:45', '09:00', '09:45', '10:00', '10:15', '16:00'];

  it.each(probes)('start %s with the only technician blocked 09:00-10:00', async (time) => {
    await testDb.reset();
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.block('technician', world.technicianIds[0]!, blockBody('09:00', '10:00'));

    const listed = (await slots(world)).includes(time);
    const res = await api.book(bookingBody(world, monday(time)));
    expect(
      res.statusCode === 201,
      `availability says ${listed}, booking returned ${res.statusCode}`,
    ).toBe(listed);
  });

  it('a capacity conflict never offers a blocked time as an alternative', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    await api.block('bay', world.bayIds[0]!, blockBody('10:00', '12:00'));
    await api.book(bookingBody(world, monday('09:00')));
    const res = await api.book(bookingBody(world, monday('09:00')));
    const times = (res.json().alternatives as { startTime: string }[]).map((a) =>
      a.startTime.slice(11, 16),
    );
    expect(times.every((t) => t < '10:00' || t >= '12:00')).toBe(true);
    expect(times).toContain('08:00');
    expect(times).toContain('12:00');
  });

  it('blocks at one dealership do not touch another dealership with the same skill', async () => {
    const a = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const b = await createWorld(testDb.db, {
      withHours: true,
      bays: 1,
      technicians: 1,
      sharedWith: a,
    });
    await api.block('bay', a.bayIds[0]!, blockBody('08:00', '17:00'));
    expect(await slots(a)).toEqual([]);
    expect((await slots(b)).length).toBeGreaterThan(0);
  });
});
