import { sql } from 'kysely';
import type { Db } from '../../../src/db/index.js';

/** All names are prefixed SAMPLE so test data can never be mistaken for real data. */
export interface World {
  dealershipId: string;
  skillId: string;
  serviceTypeId: string;
  customerId: string;
  vehicleId: string;
  bayIds: string[];
  technicianIds: string[];
}

export interface WorldOptions {
  bays?: number;
  /** Technicians who hold the required skill. */
  technicians?: number;
  /** Technicians at the same dealership who do NOT hold the required skill. */
  unqualifiedTechnicians?: number;
  /** Add Monday-Friday 08:00-17:00 working hours (needed for booking tests). */
  withHours?: boolean;
  durationMinutes?: number;
  bufferMinutes?: number;
  timeZone?: string;
}

/** Create one dealership with bays, qualified technicians, a service type, a customer and a vehicle. */
export async function createWorld(db: Db, options: WorldOptions = {}): Promise<World> {
  const { bays = 2, technicians = 2, durationMinutes = 60, bufferMinutes = 0 } = options;
  const unqualified = options.unqualifiedTechnicians ?? 0;

  const dealership = await db
    .insertInto('dealership')
    .values({ name: 'SAMPLE Dealership', time_zone: options.timeZone ?? 'Europe/London' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const skill = await db
    .insertInto('skill')
    .values({ name: 'SAMPLE brakes' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const serviceType = await db
    .insertInto('service_type')
    .values({
      name: 'SAMPLE brake service',
      duration_minutes: durationMinutes,
      buffer_minutes: bufferMinutes,
      required_skill_id: skill.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const customer = await db
    .insertInto('customer')
    .values({ name: 'SAMPLE Customer', contact: 'sample@example.invalid' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const vehicle = await db
    .insertInto('vehicle')
    .values({
      customer_id: customer.id,
      vin: `SAMPLEVIN${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      make: 'SAMPLE',
      model: 'Model',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const bayIds: string[] = [];
  for (let i = 1; i <= bays; i++) {
    const bay = await db
      .insertInto('service_bay')
      .values({ dealership_id: dealership.id, name: `SAMPLE Bay ${i}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    bayIds.push(bay.id);
  }

  if (options.withHours) {
    await db
      .insertInto('dealership_hours')
      .values(
        [1, 2, 3, 4, 5].map((weekday) => ({
          dealership_id: dealership.id,
          weekday,
          open_time: '08:00',
          close_time: '17:00',
        })),
      )
      .execute();
  }

  const technicianIds: string[] = [];
  for (let i = 1; i <= technicians; i++) {
    const technician = await db
      .insertInto('technician')
      .values({ dealership_id: dealership.id, name: `SAMPLE Technician ${i}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('technician_skill')
      .values({ technician_id: technician.id, skill_id: skill.id })
      .execute();
    technicianIds.push(technician.id);
  }

  for (let i = 1; i <= unqualified; i++) {
    // No technician_skill row, so this person can never be assigned the service.
    await db
      .insertInto('technician')
      .values({ dealership_id: dealership.id, name: `SAMPLE Unqualified ${i}` })
      .execute();
  }

  return {
    dealershipId: dealership.id,
    skillId: skill.id,
    serviceTypeId: serviceType.id,
    customerId: customer.id,
    vehicleId: vehicle.id,
    bayIds,
    technicianIds,
  };
}

export interface AppointmentInput {
  bayId: string;
  technicianId: string;
  /** ISO start of the occupied period (inclusive). */
  start: string;
  /** ISO end of the occupied period (exclusive). */
  end: string;
  key: string;
  status?: 'confirmed' | 'cancelled';
  /** Range bounds. Default '[)' (half-open). Pass '[]' to build an invalid inclusive-upper range. */
  bounds?: '[)' | '[]';
}

/** Insert an appointment row directly, bypassing the service layer (for schema-level tests). */
export function insertAppointment(db: Db, world: World, input: AppointmentInput) {
  return db
    .insertInto('appointment')
    .values({
      customer_id: world.customerId,
      vehicle_id: world.vehicleId,
      service_type_id: world.serviceTypeId,
      dealership_id: world.dealershipId,
      bay_id: input.bayId,
      technician_id: input.technicianId,
      occupied_period: sql<string>`tstzrange(${input.start}::timestamptz, ${input.end}::timestamptz, ${input.bounds ?? '[)'})`,
      service_end: new Date(input.end),
      status: input.status ?? 'confirmed',
      idempotency_key: input.key,
      request_hash: 'sample-hash',
      cancelled_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

/** Postgres error details we assert on (error codes are stable across versions). */
export const PG = {
  UNIQUE: '23505',
  FOREIGN_KEY: '23503',
  CHECK: '23514',
  EXCLUSION: '23P01',
} as const;

/** Assert a promise rejects with a Postgres error of the given code (and constraint name, if given). */
export async function expectPgError(
  promise: PromiseLike<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; constraint?: string; message?: string };
    if (e.code !== expected.code || (expected.constraint && e.constraint !== expected.constraint)) {
      throw new Error(
        `Expected Postgres error ${expected.code}${expected.constraint ? ` on ${expected.constraint}` : ''}, ` +
          `got ${e.code ?? 'no code'}${e.constraint ? ` on ${e.constraint}` : ''}: ${e.message}`,
        { cause: error },
      );
    }
    return;
  }
  throw new Error(
    `Expected Postgres error ${expected.code}${expected.constraint ? ` on ${expected.constraint}` : ''}, but the statement succeeded`,
  );
}
