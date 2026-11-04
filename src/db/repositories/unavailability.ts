import { sql } from 'kysely';
import { range, type TimeRange } from '../../domain/time-range.js';
import type { Db } from '../index.js';

export type ResourceKind = 'bay' | 'technician';

/** Identifiers come from this fixed table only, never from user input, so they are safe to inline. */
const TABLES = {
  bay: { resource: 'service_bay', block: 'bay_unavailability', column: 'bay_id' },
  technician: {
    resource: 'technician',
    block: 'technician_unavailability',
    column: 'technician_id',
  },
} as const;

export interface UnavailabilityRecord {
  id: string;
  resourceId: string;
  startTime: Date;
  endTime: Date;
  reason: string;
}

const period = (p: TimeRange) =>
  sql`tstzrange(${p.start}::timestamptz, ${p.end}::timestamptz, '[)')`;

/**
 * Lock the bay or technician row, WAITING if a booking or another block holds it. This is the
 * same lock a booking takes (without waiting) on the resource it picks, so a block and a booking
 * for one resource can never both pass their checks. Returns false when the resource is unknown.
 */
export async function lockResource(db: Db, kind: ResourceKind, id: string): Promise<boolean> {
  const t = TABLES[kind];
  const { rows } = await sql`
    SELECT id FROM ${sql.table(t.resource)} WHERE id = ${id} FOR NO KEY UPDATE`.execute(db);
  return rows.length > 0;
}

/** True when a confirmed appointment of this resource shares time with the period. */
export async function hasConfirmedAppointment(
  db: Db,
  kind: ResourceKind,
  id: string,
  p: TimeRange,
): Promise<boolean> {
  const t = TABLES[kind];
  const { rows } = await sql<{ busy: boolean }>`
    SELECT EXISTS (SELECT 1 FROM appointment a
                    WHERE a.${sql.ref(t.column)} = ${id} AND a.status = 'confirmed'
                      AND a.occupied_period && ${period(p)}) AS busy`.execute(db);
  return rows[0]?.busy === true;
}

/**
 * Insert a block. The database rejects an overlapping block on the same resource with an
 * exclusion violation (23P01), which the caller turns into UNAVAILABILITY_OVERLAP.
 */
export async function insertBlock(
  db: Db,
  kind: ResourceKind,
  id: string,
  p: TimeRange,
  reason: string,
): Promise<UnavailabilityRecord> {
  const t = TABLES[kind];
  const { rows } = await sql<{ id: string; start: Date; end: Date }>`
    INSERT INTO ${sql.table(t.block)} (${sql.ref(t.column)}, period, reason)
    VALUES (${id}, ${period(p)}, ${reason})
    RETURNING id, lower(period) AS start, upper(period) AS "end"`.execute(db);
  const row = rows[0]!;
  const r = range(row.start, row.end);
  return { id: row.id, resourceId: id, startTime: r.start, endTime: r.end, reason };
}

/** True when the bay or technician exists. */
export async function resourceExists(db: Db, kind: ResourceKind, id: string): Promise<boolean> {
  const t = TABLES[kind];
  const { rows } = await sql`SELECT 1 FROM ${sql.table(t.resource)} WHERE id = ${id}`.execute(db);
  return rows.length > 0;
}

/** Every block of one resource, earliest first. */
export async function listBlocks(
  db: Db,
  kind: ResourceKind,
  resourceId: string,
): Promise<UnavailabilityRecord[]> {
  const t = TABLES[kind];
  const { rows } = await sql<{ id: string; start: Date; end: Date; reason: string }>`
    SELECT id, lower(period) AS start, upper(period) AS "end", reason
      FROM ${sql.table(t.block)}
     WHERE ${sql.ref(t.column)} = ${resourceId}
     ORDER BY lower(period), id`.execute(db);
  return rows.map((r) => ({
    id: r.id,
    resourceId,
    startTime: r.start,
    endTime: r.end,
    reason: r.reason,
  }));
}

/**
 * Delete one block of one resource. Both ids must match, so a block can never be removed through
 * the wrong resource or the wrong kind. Returns false when there was nothing to delete.
 */
export async function deleteBlock(
  db: Db,
  kind: ResourceKind,
  resourceId: string,
  blockId: string,
): Promise<boolean> {
  const t = TABLES[kind];
  const { rows } = await sql`
    DELETE FROM ${sql.table(t.block)}
     WHERE id = ${blockId} AND ${sql.ref(t.column)} = ${resourceId}
    RETURNING id`.execute(db);
  return rows.length > 0;
}
