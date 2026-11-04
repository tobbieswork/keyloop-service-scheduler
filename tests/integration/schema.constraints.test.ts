import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../../src/db/migrate.js';
import {
  createWorld,
  expectPgError,
  insertAppointment,
  PG,
  type World,
} from './helpers/fixtures.js';
import { startTestDb, type TestDb } from './helpers/db.js';

const at = (hhmm: string, day = '2030-03-04') => `${day}T${hhmm}:00Z`;

let testDb: TestDb;
let world: World;

beforeAll(async () => {
  testDb = await startTestDb();
});
afterAll(async () => {
  await testDb.stop();
});
beforeEach(async () => {
  await testDb.reset();
  world = await createWorld(testDb.db, { bays: 2, technicians: 2 });
});

describe('migrations', () => {
  it('are idempotent: a second run applies nothing', async () => {
    const outcome = await migrateToLatest(testDb.db);
    expect(outcome.applied).toEqual([]);
  });
});

describe('appointment invariants (FR-005, FR-006, FR-007, FR-013, FR-016)', () => {
  it('stores a confirmed appointment linking customer, vehicle, bay and technician', async () => {
    const [bayId, technicianId] = [world.bayIds[0]!, world.technicianIds[0]!];
    const { id } = await insertAppointment(testDb.db, world, {
      bayId,
      technicianId,
      start: at('09:00'),
      end: at('10:00'),
      key: 'k1',
    });
    const row = await testDb.db
      .selectFrom('appointment')
      .select(['customer_id', 'vehicle_id', 'bay_id', 'technician_id', 'status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      customer_id: world.customerId,
      vehicle_id: world.vehicleId,
      bay_id: bayId,
      technician_id: technicianId,
      status: 'confirmed',
    });
  });

  it('rejects an overlapping appointment in the same bay, even with another technician', async () => {
    await insertAppointment(testDb.db, world, {
      bayId: world.bayIds[0]!,
      technicianId: world.technicianIds[0]!,
      start: at('09:00'),
      end: at('10:00'),
      key: 'k1',
    });
    await expectPgError(
      insertAppointment(testDb.db, world, {
        bayId: world.bayIds[0]!,
        technicianId: world.technicianIds[1]!,
        start: at('09:30'),
        end: at('10:30'),
        key: 'k2',
      }),
      { code: PG.EXCLUSION, constraint: 'appointment_no_bay_overlap' },
    );
  });

  it('rejects an overlapping appointment for the same technician, even in another bay', async () => {
    await insertAppointment(testDb.db, world, {
      bayId: world.bayIds[0]!,
      technicianId: world.technicianIds[0]!,
      start: at('09:00'),
      end: at('10:00'),
      key: 'k1',
    });
    await expectPgError(
      insertAppointment(testDb.db, world, {
        bayId: world.bayIds[1]!,
        technicianId: world.technicianIds[0]!,
        start: at('09:30'),
        end: at('10:30'),
        key: 'k2',
      }),
      { code: PG.EXCLUSION, constraint: 'appointment_no_technician_overlap' },
    );
  });

  it('allows back-to-back appointments: end equals next start is not an overlap', async () => {
    const bayId = world.bayIds[0]!;
    const technicianId = world.technicianIds[0]!;
    await insertAppointment(testDb.db, world, {
      bayId,
      technicianId,
      start: at('09:00'),
      end: at('10:00'),
      key: 'k1',
    });
    await expect(
      insertAppointment(testDb.db, world, {
        bayId,
        technicianId,
        start: at('10:00'),
        end: at('11:00'),
        key: 'k2',
      }),
    ).resolves.toBeDefined();
  });

  it('allows the same time slot on a different bay with a different technician', async () => {
    await insertAppointment(testDb.db, world, {
      bayId: world.bayIds[0]!,
      technicianId: world.technicianIds[0]!,
      start: at('09:00'),
      end: at('10:00'),
      key: 'k1',
    });
    await expect(
      insertAppointment(testDb.db, world, {
        bayId: world.bayIds[1]!,
        technicianId: world.technicianIds[1]!,
        start: at('09:00'),
        end: at('10:00'),
        key: 'k2',
      }),
    ).resolves.toBeDefined();
  });

  it('frees the slot when an appointment is cancelled, and keeps the cancelled record', async () => {
    const slot = { bayId: world.bayIds[0]!, technicianId: world.technicianIds[0]! };
    const first = await insertAppointment(testDb.db, world, {
      ...slot,
      start: at('09:00'),
      end: at('10:00'),
      key: 'k1',
    });
    await testDb.db
      .updateTable('appointment')
      .set({ status: 'cancelled', cancelled_at: new Date() })
      .where('id', '=', first.id)
      .execute();

    await expect(
      insertAppointment(testDb.db, world, {
        ...slot,
        start: at('09:00'),
        end: at('10:00'),
        key: 'k2',
      }),
    ).resolves.toBeDefined();

    const cancelled = await testDb.db
      .selectFrom('appointment')
      .select('status')
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow();
    expect(cancelled.status).toBe('cancelled');
  });

  it('rejects a second booking for a slot that was freed and then retaken', async () => {
    const slot = { bayId: world.bayIds[0]!, technicianId: world.technicianIds[0]! };
    const first = await insertAppointment(testDb.db, world, {
      ...slot,
      start: at('09:00'),
      end: at('10:00'),
      key: 'k1',
    });
    await testDb.db
      .updateTable('appointment')
      .set({ status: 'cancelled' })
      .where('id', '=', first.id)
      .execute();
    await insertAppointment(testDb.db, world, {
      ...slot,
      start: at('09:00'),
      end: at('10:00'),
      key: 'k2',
    });
    await expectPgError(
      insertAppointment(testDb.db, world, {
        ...slot,
        start: at('09:00'),
        end: at('10:00'),
        key: 'k3',
      }),
      { code: PG.EXCLUSION, constraint: 'appointment_no_bay_overlap' },
    );
  });

  it('rejects a duplicate idempotency key', async () => {
    await insertAppointment(testDb.db, world, {
      bayId: world.bayIds[0]!,
      technicianId: world.technicianIds[0]!,
      start: at('09:00'),
      end: at('10:00'),
      key: 'same-key',
    });
    await expectPgError(
      insertAppointment(testDb.db, world, {
        bayId: world.bayIds[1]!,
        technicianId: world.technicianIds[1]!,
        start: at('13:00'),
        end: at('14:00'),
        key: 'same-key',
      }),
      { code: PG.UNIQUE, constraint: 'appointment_idempotency_key_key' },
    );
  });

  it('rejects an empty occupied period', async () => {
    await expectPgError(
      insertAppointment(testDb.db, world, {
        bayId: world.bayIds[0]!,
        technicianId: world.technicianIds[0]!,
        start: at('09:00'),
        end: at('09:00'),
        key: 'k1',
      }),
      { code: PG.CHECK, constraint: 'appointment_period_valid' },
    );
  });

  it('rejects a period whose upper bound is inclusive', async () => {
    await expectPgError(
      insertAppointment(testDb.db, world, {
        bayId: world.bayIds[0]!,
        technicianId: world.technicianIds[0]!,
        start: at('09:00'),
        end: at('10:00'),
        key: 'k1',
        bounds: '[]',
      }),
      { code: PG.CHECK, constraint: 'appointment_period_valid' },
    );
  });

  it('rejects an appointment that points at a bay that does not exist', async () => {
    await expectPgError(
      insertAppointment(testDb.db, world, {
        bayId: '00000000-0000-0000-0000-000000000000',
        technicianId: world.technicianIds[0]!,
        start: at('09:00'),
        end: at('10:00'),
        key: 'k1',
      }),
      { code: PG.FOREIGN_KEY },
    );
  });
});

describe('unavailability periods (FR-015)', () => {
  const range = (start: string, end: string, bounds = '[)') =>
    sql<string>`tstzrange(${start}::timestamptz, ${end}::timestamptz, ${bounds})`;

  it('rejects overlapping blocks on the same bay, allows other bays and adjacent blocks', async () => {
    const insert = (bayId: string, start: string, end: string) =>
      testDb.db
        .insertInto('bay_unavailability')
        .values({ bay_id: bayId, period: range(start, end), reason: 'SAMPLE maintenance' })
        .execute();
    await insert(world.bayIds[0]!, at('09:00'), at('12:00'));

    await expectPgError(insert(world.bayIds[0]!, at('11:00'), at('13:00')), {
      code: PG.EXCLUSION,
      constraint: 'bay_unavailability_no_overlap',
    });
    await expect(insert(world.bayIds[1]!, at('11:00'), at('13:00'))).resolves.toBeDefined();
    await expect(insert(world.bayIds[0]!, at('12:00'), at('13:00'))).resolves.toBeDefined();
  });

  it('rejects overlapping blocks on the same technician, allows other technicians and adjacent blocks', async () => {
    const insert = (technicianId: string, start: string, end: string) =>
      testDb.db
        .insertInto('technician_unavailability')
        .values({ technician_id: technicianId, period: range(start, end), reason: 'SAMPLE leave' })
        .execute();
    await insert(world.technicianIds[0]!, at('09:00'), at('12:00'));

    await expectPgError(insert(world.technicianIds[0]!, at('11:00'), at('13:00')), {
      code: PG.EXCLUSION,
      constraint: 'technician_unavailability_no_overlap',
    });
    await expect(insert(world.technicianIds[1]!, at('11:00'), at('13:00'))).resolves.toBeDefined();
    await expect(insert(world.technicianIds[0]!, at('12:00'), at('13:00'))).resolves.toBeDefined();
  });

  it('rejects an empty block period', async () => {
    await expectPgError(
      testDb.db
        .insertInto('bay_unavailability')
        .values({ bay_id: world.bayIds[0]!, period: range(at('09:00'), at('09:00')), reason: 'x' })
        .execute(),
      { code: PG.CHECK, constraint: 'bay_unavailability_period_valid' },
    );
    await expectPgError(
      testDb.db
        .insertInto('technician_unavailability')
        .values({
          technician_id: world.technicianIds[0]!,
          period: range(at('09:00'), at('09:00')),
          reason: 'x',
        })
        .execute(),
      { code: PG.CHECK, constraint: 'technician_unavailability_period_valid' },
    );
  });
});

describe('reference data rules', () => {
  it('rejects a duplicate VIN', async () => {
    const existing = await testDb.db
      .selectFrom('vehicle')
      .select('vin')
      .where('id', '=', world.vehicleId)
      .executeTakeFirstOrThrow();
    await expectPgError(
      testDb.db
        .insertInto('vehicle')
        .values({ customer_id: world.customerId, vin: existing.vin, make: 'SAMPLE', model: 'M' })
        .execute(),
      { code: PG.UNIQUE, constraint: 'vehicle_vin_key' },
    );
  });

  it('rejects a service type with zero duration or a negative buffer', async () => {
    await expectPgError(
      testDb.db
        .insertInto('service_type')
        .values({ name: 'SAMPLE', duration_minutes: 0, required_skill_id: world.skillId })
        .execute(),
      { code: PG.CHECK, constraint: 'service_type_duration_positive' },
    );
    await expectPgError(
      testDb.db
        .insertInto('service_type')
        .values({
          name: 'SAMPLE',
          duration_minutes: 30,
          buffer_minutes: -5,
          required_skill_id: world.skillId,
        })
        .execute(),
      { code: PG.CHECK, constraint: 'service_type_buffer_not_negative' },
    );
  });

  it('rejects invalid working hours: weekday out of range, closing before opening, duplicate day', async () => {
    const hours = (weekday: number, open: string, close: string) =>
      testDb.db
        .insertInto('dealership_hours')
        .values({
          dealership_id: world.dealershipId,
          weekday,
          open_time: open,
          close_time: close,
        })
        .execute();

    await expectPgError(hours(7, '08:00', '17:00'), {
      code: PG.CHECK,
      constraint: 'dealership_hours_weekday_valid',
    });
    await expectPgError(hours(1, '17:00', '08:00'), {
      code: PG.CHECK,
      constraint: 'dealership_hours_close_after_open',
    });
    await hours(1, '08:00', '17:00');
    await expectPgError(hours(1, '09:00', '18:00'), { code: PG.UNIQUE });
  });
});
