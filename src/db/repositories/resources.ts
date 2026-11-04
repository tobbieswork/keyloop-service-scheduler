import { sql } from 'kysely';
import type { ResourceCandidate, TechnicianCandidate } from '../../domain/resource-selection.js';
import type { TimeRange } from '../../domain/time-range.js';
import type { Db } from '../index.js';

// "Free" means: no confirmed appointment overlaps the occupied period. `&&` is the range
// overlap operator, and ranges are half-open, so back-to-back appointments do not overlap.
const period = (p: TimeRange) =>
  sql`tstzrange(${p.start}::timestamptz, ${p.end}::timestamptz, '[)')`;

/**
 * Bays at the dealership that are free for the period, with how many confirmed appointments
 * each already has that local day (`day` is the day's start and end as instants).
 */
export async function freeBays(
  db: Db,
  dealershipId: string,
  occupied: TimeRange,
  day: TimeRange,
): Promise<ResourceCandidate[]> {
  const { rows } = await sql<{ id: string; booked: number }>`
    SELECT b.id,
           (SELECT count(*)::int FROM appointment a
             WHERE a.bay_id = b.id AND a.status = 'confirmed'
               AND lower(a.occupied_period) >= ${day.start}::timestamptz
               AND lower(a.occupied_period) <  ${day.end}::timestamptz) AS booked
      FROM service_bay b
     WHERE b.dealership_id = ${dealershipId}
       AND NOT EXISTS (SELECT 1 FROM appointment a
                        WHERE a.bay_id = b.id AND a.status = 'confirmed'
                          AND a.occupied_period && ${period(occupied)})`.execute(db);
  return rows.map((r) => ({ id: r.id, bookedThatDay: r.booked }));
}

/** Technicians at the dealership that are free for the period, with their skills and day load. */
export async function freeTechnicians(
  db: Db,
  dealershipId: string,
  occupied: TimeRange,
  day: TimeRange,
): Promise<TechnicianCandidate[]> {
  const { rows } = await sql<{ id: string; booked: number; skill_ids: string[] }>`
    SELECT t.id,
           (SELECT count(*)::int FROM appointment a
             WHERE a.technician_id = t.id AND a.status = 'confirmed'
               AND lower(a.occupied_period) >= ${day.start}::timestamptz
               AND lower(a.occupied_period) <  ${day.end}::timestamptz) AS booked,
           COALESCE((SELECT array_agg(ts.skill_id::text) FROM technician_skill ts
                      WHERE ts.technician_id = t.id), '{}') AS skill_ids
      FROM technician t
     WHERE t.dealership_id = ${dealershipId}
       AND NOT EXISTS (SELECT 1 FROM appointment a
                        WHERE a.technician_id = t.id AND a.status = 'confirmed'
                          AND a.occupied_period && ${period(occupied)})`.execute(db);
  return rows.map((r) => ({ id: r.id, bookedThatDay: r.booked, skillIds: r.skill_ids }));
}

/**
 * Take a row lock on the bay for the rest of the transaction, WITHOUT waiting. The lock mode is
 * FOR NO KEY UPDATE, not FOR UPDATE: it still excludes other bookings (which take the same lock)
 * but, unlike FOR UPDATE, it does not block the foreign-key check that any insert of an
 * appointment pointing at this bay performs, so no unrelated writer can get stuck behind it. Returns false
 * when another in-flight booking already holds it, so the caller moves on to the next candidate
 * instead of queueing behind it (which also makes deadlocks impossible).
 */
export async function tryLockBay(db: Db, bayId: string): Promise<boolean> {
  const { rows } = await sql`
    SELECT id FROM service_bay WHERE id = ${bayId} FOR NO KEY UPDATE SKIP LOCKED`.execute(db);
  return rows.length > 0;
}

export async function tryLockTechnician(db: Db, technicianId: string): Promise<boolean> {
  const { rows } = await sql`
    SELECT id FROM technician WHERE id = ${technicianId} FOR NO KEY UPDATE SKIP LOCKED`.execute(db);
  return rows.length > 0;
}

/**
 * Re-check, after the locks are held, that the chosen bay and technician are still free. The
 * earlier lists were read before the locks, so another booking may have committed in between.
 */
export async function stillFree(
  db: Db,
  bayId: string,
  technicianId: string,
  occupied: TimeRange,
): Promise<boolean> {
  const { rows } = await sql<{ busy: boolean }>`
    SELECT EXISTS (SELECT 1 FROM appointment a
                    WHERE a.status = 'confirmed'
                      AND (a.bay_id = ${bayId} OR a.technician_id = ${technicianId})
                      AND a.occupied_period && ${period(occupied)}) AS busy`.execute(db);
  return rows[0]?.busy === false;
}
