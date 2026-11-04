/** A bay or technician that is free for the requested period, with how busy they are that day. */
export interface ResourceCandidate {
  id: string;
  /** Confirmed appointments already assigned to this resource on the requested local date. */
  bookedThatDay: number;
}

export interface TechnicianCandidate extends ResourceCandidate {
  skillIds: readonly string[];
}

/**
 * Order candidates for assignment (FR-017): fewest appointments that day first, ties broken by
 * the lowest ID. The result depends only on the data, never on the input order, so the same
 * request always picks the same resource. IDs are compared as lower-case text, which matches
 * the byte order PostgreSQL uses for UUIDs.
 */
export function rankByLeastBooked<T extends ResourceCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    if (a.bookedThatDay !== b.bookedThatDay) return a.bookedThatDay - b.bookedThatDay;
    const idA = a.id.toLowerCase();
    const idB = b.id.toLowerCase();
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}

/** Technicians who hold the skill the service type requires (FR-004). Exact match only. */
export function qualifiedTechnicians<T extends TechnicianCandidate>(
  technicians: readonly T[],
  requiredSkillId: string,
): T[] {
  return technicians.filter((t) => t.skillIds.includes(requiredSkillId));
}
