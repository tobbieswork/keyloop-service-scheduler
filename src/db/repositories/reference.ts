import type { HoursByWeekday } from '../../domain/working-hours.js';
import type { Db } from '../index.js';

export interface DealershipInfo {
  id: string;
  timeZone: string;
  hours: HoursByWeekday;
}

export interface ServiceTypeInfo {
  id: string;
  durationMinutes: number;
  bufferMinutes: number;
  requiredSkillId: string;
}

export async function getDealership(db: Db, id: string): Promise<DealershipInfo | undefined> {
  const dealership = await db
    .selectFrom('dealership')
    .select(['id', 'time_zone'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!dealership) return undefined;

  const rows = await db
    .selectFrom('dealership_hours')
    .select(['weekday', 'open_time', 'close_time'])
    .where('dealership_id', '=', id)
    .execute();
  return {
    id: dealership.id,
    timeZone: dealership.time_zone,
    hours: new Map(rows.map((r) => [r.weekday, { open: r.open_time, close: r.close_time }])),
  };
}

export async function getServiceType(db: Db, id: string): Promise<ServiceTypeInfo | undefined> {
  const row = await db
    .selectFrom('service_type')
    .select(['id', 'duration_minutes', 'buffer_minutes', 'required_skill_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  return (
    row && {
      id: row.id,
      durationMinutes: row.duration_minutes,
      bufferMinutes: row.buffer_minutes,
      requiredSkillId: row.required_skill_id,
    }
  );
}

export async function customerExists(db: Db, id: string): Promise<boolean> {
  const row = await db.selectFrom('customer').select('id').where('id', '=', id).executeTakeFirst();
  return row !== undefined;
}

export async function getVehicle(
  db: Db,
  id: string,
): Promise<{ id: string; customerId: string } | undefined> {
  const row = await db
    .selectFrom('vehicle')
    .select(['id', 'customer_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row && { id: row.id, customerId: row.customer_id };
}
