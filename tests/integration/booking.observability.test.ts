import { sql } from 'kysely';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, monday, startApi, type TestApi } from './helpers/api.js';
import { startTestDb, type TestDb } from './helpers/db.js';
import { createWorld } from './helpers/fixtures.js';

let testDb: TestDb;
let api: TestApi;
let logged: string[];

beforeAll(async () => {
  testDb = await startTestDb();
  logged = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      logged.push(String(chunk));
      done();
    },
  });
  api = await startApi(testDb, undefined, { logStream: stream });
});
afterAll(async () => {
  await api.app.close();
  await testDb.stop();
});
beforeEach(async () => {
  await testDb.reset();
  logged.length = 0;
});

const metrics = async () => (await api.app.inject({ method: 'GET', url: '/metrics' })).body;
/** The value of a counter line such as `scheduler_booking_outcomes_total{result="confirmed"} 3`. */
const counter = (text: string, line: string) => {
  const m = new RegExp(`^${line.replace(/[{}"]/g, '\\$&')} (\\d+)$`, 'm').exec(text);
  return m ? Number(m[1]) : 0;
};
const outcome = (text: string, result: string) =>
  counter(text, `scheduler_booking_outcomes_total{result="${result}"}`);

describe('booking metrics', () => {
  it('counts confirmed, conflict and invalid outcomes separately', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const before = await metrics();

    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(201); // confirmed
    expect((await api.book(bookingBody(world, monday('09:00')))).statusCode).toBe(409); // conflict
    expect((await api.book(bookingBody(world, monday('07:00')))).statusCode).toBe(422); // invalid

    const after = await metrics();
    expect(outcome(after, 'confirmed') - outcome(before, 'confirmed')).toBe(1);
    expect(outcome(after, 'conflict') - outcome(before, 'conflict')).toBe(1);
    expect(outcome(after, 'invalid') - outcome(before, 'invalid')).toBe(1);
  });

  it('does not count a replayed request as a new confirmed booking', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    await api.book(bookingBody(world, monday('09:00')), 'metrics-replay-key');
    const before = outcome(await metrics(), 'confirmed');
    await api.book(bookingBody(world, monday('09:00')), 'metrics-replay-key');
    expect(outcome(await metrics(), 'confirmed')).toBe(before);
  });

  it('records the time spent booking', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const count = (text: string) => counter(text, 'scheduler_booking_duration_seconds_count');
    const before = count(await metrics());
    await api.book(bookingBody(world, monday('09:00')));
    expect(count(await metrics())).toBe(before + 1);
  });
});

describe('booking logs (FR-014)', () => {
  const linesFor = () => logged.map((l) => JSON.parse(l) as Record<string, unknown>);

  it('logs each outcome with the request ID, IDs and the result', async () => {
    const world = await createWorld(testDb.db, { withHours: true, bays: 1, technicians: 1 });
    const res = await api.app.inject({
      method: 'POST',
      url: '/appointments',
      headers: { 'idempotency-key': 'log-test-key-1', 'x-request-id': 'log-req-1' },
      payload: bookingBody(world, monday('09:00')),
    });
    const created = res.json();
    const line = linesFor().find((l) => l['outcome'] === 'confirmed');
    expect(line).toMatchObject({
      reqId: 'log-req-1',
      outcome: 'confirmed',
      appointmentId: created.id,
      dealershipId: world.dealershipId,
      bayId: created.bayId,
      technicianId: created.technicianId,
    });

    await api.app.inject({
      method: 'POST',
      url: '/appointments',
      headers: { 'idempotency-key': 'log-test-key-2', 'x-request-id': 'log-req-2' },
      payload: bookingBody(world, monday('09:00')),
    });
    expect(
      linesFor().find((l) => l['reqId'] === 'log-req-2' && l['outcome'] === 'conflict'),
    ).toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('never logs the customer name, contact, VIN or idempotency key', async () => {
    const world = await createWorld(testDb.db, { withHours: true });
    const { rows } = await sql<{ vin: string; name: string; contact: string }>`
      SELECT v.vin, c.name, c.contact FROM vehicle v JOIN customer c ON c.id = v.customer_id
       WHERE v.id = ${world.vehicleId}`.execute(testDb.db);
    const person = rows[0]!;

    await api.app.inject({
      method: 'POST',
      url: '/appointments',
      headers: { 'idempotency-key': 'secret-idempotency-key-xyz' },
      payload: bookingBody(world, monday('09:00')),
    });
    await api.book(bookingBody(world, monday('07:00'))); // a rejected one too

    const everything = logged.join('');
    expect(everything.length).toBeGreaterThan(0);
    expect(everything).not.toContain(person.vin);
    expect(everything).not.toContain(person.name);
    expect(everything).not.toContain(person.contact);
    expect(everything).not.toContain('secret-idempotency-key-xyz');
  });
});
