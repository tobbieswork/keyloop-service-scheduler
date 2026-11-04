import { sql } from 'kysely';
import type { TimeRange } from '../../domain/time-range.js';
import type { Db } from '../index.js';
import type { AppointmentStatus } from '../types.js';

/** An appointment as the application sees it (times are real instants, not range text). */
export interface AppointmentRecord {
  id: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  dealershipId: string;
  bayId: string;
  technicianId: string;
  /** Start of the occupied period. */
  startTime: Date;
  /** End of the work itself, without the buffer. */
  serviceEnd: Date;
  /** End of the occupied period: the service end plus the buffer. */
  occupiedUntil: Date;
  status: AppointmentStatus;
  cancelledAt: Date | null;
  requestHash: string;
}

export interface NewAppointment {
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  dealershipId: string;
  bayId: string;
  technicianId: string;
  occupied: TimeRange;
  serviceEnd: Date;
  idempotencyKey: string;
  requestHash: string;
}

// The range column is read with lower()/upper() so the app never parses the range text format.
const select = (db: Db) =>
  db
    .selectFrom('appointment')
    .select([
      'id',
      'customer_id',
      'vehicle_id',
      'service_type_id',
      'dealership_id',
      'bay_id',
      'technician_id',
      'service_end',
      'status',
      'cancelled_at',
      'request_hash',
      sql<Date>`lower(occupied_period)`.as('start_time'),
      sql<Date>`upper(occupied_period)`.as('occupied_until'),
    ]);

type Row = Awaited<ReturnType<ReturnType<typeof select>['executeTakeFirstOrThrow']>>;

const toRecord = (r: Row): AppointmentRecord => ({
  id: r.id,
  customerId: r.customer_id,
  vehicleId: r.vehicle_id,
  serviceTypeId: r.service_type_id,
  dealershipId: r.dealership_id,
  bayId: r.bay_id,
  technicianId: r.technician_id,
  startTime: r.start_time,
  serviceEnd: r.service_end,
  occupiedUntil: r.occupied_until,
  status: r.status,
  cancelledAt: r.cancelled_at,
  requestHash: r.request_hash,
});

export async function findAppointmentById(
  db: Db,
  id: string,
): Promise<AppointmentRecord | undefined> {
  const row = await select(db).where('id', '=', id).executeTakeFirst();
  return row && toRecord(row);
}

export async function findAppointmentByIdempotencyKey(
  db: Db,
  key: string,
): Promise<AppointmentRecord | undefined> {
  const row = await select(db).where('idempotency_key', '=', key).executeTakeFirst();
  return row && toRecord(row);
}

/**
 * Insert a confirmed appointment. The database's exclusion constraints reject an overlapping
 * bay or technician (error 23P01) and a repeated idempotency key (error 23505); callers handle
 * both.
 */
export async function insertAppointment(db: Db, a: NewAppointment): Promise<AppointmentRecord> {
  const { id } = await db
    .insertInto('appointment')
    .values({
      customer_id: a.customerId,
      vehicle_id: a.vehicleId,
      service_type_id: a.serviceTypeId,
      dealership_id: a.dealershipId,
      bay_id: a.bayId,
      technician_id: a.technicianId,
      occupied_period: sql<string>`tstzrange(${a.occupied.start}::timestamptz, ${a.occupied.end}::timestamptz, '[)')`,
      service_end: a.serviceEnd,
      idempotency_key: a.idempotencyKey,
      request_hash: a.requestHash,
      cancelled_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return toRecord(await select(db).where('id', '=', id).executeTakeFirstOrThrow());
}
