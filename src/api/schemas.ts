import { z } from 'zod';
import type { AppointmentRecord } from '../db/repositories/appointments.js';

/** `guid` accepts any 8-4-4-4-12 hex ID, the same leniency as the contract's `uuid` format. */
export const id = z.guid();

export const bookingBodySchema = z.object({
  customerId: id,
  vehicleId: id,
  serviceTypeId: id,
  dealershipId: id,
  // ISO 8601 with a time zone offset (or Z), so the instant is never ambiguous.
  startTime: z.iso.datetime({ offset: true }),
});

export const idParamsSchema = z.object({ id });

export const idempotencyHeaderSchema = z.object({
  'idempotency-key': z.string().min(8).max(128),
});

export const appointmentSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  vehicleId: z.string(),
  serviceTypeId: z.string(),
  dealershipId: z.string(),
  bayId: z.string(),
  technicianId: z.string(),
  startTime: z.string(),
  serviceEndTime: z.string(),
  occupiedUntil: z.string(),
  status: z.enum(['confirmed', 'cancelled']),
  cancelledAt: z.string().nullable(),
});

export type AppointmentDto = z.infer<typeof appointmentSchema>;

/** The public shape of an appointment: UTC instants as ISO 8601 strings. */
export function toAppointmentDto(a: AppointmentRecord): AppointmentDto {
  return {
    id: a.id,
    customerId: a.customerId,
    vehicleId: a.vehicleId,
    serviceTypeId: a.serviceTypeId,
    dealershipId: a.dealershipId,
    bayId: a.bayId,
    technicianId: a.technicianId,
    startTime: a.startTime.toISOString(),
    serviceEndTime: a.serviceEnd.toISOString(),
    occupiedUntil: a.occupiedUntil.toISOString(),
    status: a.status,
    cancelledAt: a.cancelledAt ? a.cancelledAt.toISOString() : null,
  };
}
