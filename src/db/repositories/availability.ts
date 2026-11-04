import { sql } from 'kysely';
import type { Resource } from '../../domain/slot-generation.js';
import { range, type TimeRange } from '../../domain/time-range.js';
import type { Db } from '../index.js';

/**
 * The bays, and the technicians qualified for a skill, at a dealership, each with the time they
 * are already committed within `day`. A technician is busy with ANY confirmed appointment,
 * whatever service it was for.
 */
export async function loadDayResources(
  db: Db,
  dealershipId: string,
  requiredSkillId: string,
  day: TimeRange,
): Promise<{ bays: Resource[]; technicians: Resource[] }> {
  const bays = await db
    .selectFrom('service_bay')
    .select('id')
    .where('dealership_id', '=', dealershipId)
    .execute();

  const technicians = await db
    .selectFrom('technician')
    .innerJoin('technician_skill', 'technician_skill.technician_id', 'technician.id')
    .select('technician.id')
    .where('technician.dealership_id', '=', dealershipId)
    .where('technician_skill.skill_id', '=', requiredSkillId)
    .execute();

  const { rows } = await sql<{ bay_id: string; technician_id: string; start: Date; end: Date }>`
    SELECT bay_id, technician_id, lower(occupied_period) AS start, upper(occupied_period) AS "end"
      FROM appointment
     WHERE dealership_id = ${dealershipId}
       AND status = 'confirmed'
       AND occupied_period && tstzrange(${day.start}::timestamptz, ${day.end}::timestamptz, '[)')`.execute(
    db,
  );

  // Blocks (bay or technician unavailable) make a resource busy exactly like an appointment does.
  const blocks = async (
    table: 'bay_unavailability' | 'technician_unavailability',
    column: string,
  ) =>
    (
      await sql<{ resource_id: string; start: Date; end: Date }>`
        SELECT ${sql.ref(column)} AS resource_id, lower(period) AS start, upper(period) AS "end"
          FROM ${sql.table(table)}
         WHERE period && tstzrange(${day.start}::timestamptz, ${day.end}::timestamptz, '[)')`.execute(
        db,
      )
    ).rows;
  const bayBlocks = await blocks('bay_unavailability', 'bay_id');
  const technicianBlocks = await blocks('technician_unavailability', 'technician_id');

  const busyBy = (key: 'bay_id' | 'technician_id', id: string): TimeRange[] => [
    ...rows.filter((r) => r[key] === id).map((r) => range(r.start, r.end)),
    ...(key === 'bay_id' ? bayBlocks : technicianBlocks)
      .filter((b) => b.resource_id === id)
      .map((b) => range(b.start, b.end)),
  ];

  return {
    bays: bays.map((b) => ({ id: b.id, busy: busyBy('bay_id', b.id) })),
    technicians: technicians.map((t) => ({ id: t.id, busy: busyBy('technician_id', t.id) })),
  };
}

export async function listDealerships(
  db: Db,
): Promise<{ id: string; name: string; timeZone: string }[]> {
  const rows = await db
    .selectFrom('dealership')
    .select(['id', 'name', 'time_zone'])
    .orderBy('name')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, timeZone: r.time_zone }));
}

export async function listServiceTypes(
  db: Db,
): Promise<{ id: string; name: string; durationMinutes: number; bufferMinutes: number }[]> {
  const rows = await db
    .selectFrom('service_type')
    .select(['id', 'name', 'duration_minutes', 'buffer_minutes'])
    .orderBy('name')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    durationMinutes: r.duration_minutes,
    bufferMinutes: r.buffer_minutes,
  }));
}
