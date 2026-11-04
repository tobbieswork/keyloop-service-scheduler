import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../api/errors.js';
import type { Db } from '../db/index.js';
import { findAppointmentById, type AppointmentRecord } from '../db/repositories/appointments.js';

export interface CancelService {
  /**
   * Cancel an appointment (FR-013). The record is kept, shown as cancelled, and its bay and
   * technician become available again because the database's overlap rules only apply to
   * confirmed appointments. Cancelling twice is allowed and returns the same record, still
   * carrying the time of the FIRST cancellation.
   */
  cancel(id: string, log: FastifyBaseLogger): Promise<AppointmentRecord>;
}

export function createCancelService(deps: { db: Db; clock: () => Date }): CancelService {
  const { db, clock } = deps;

  return {
    async cancel(id, log) {
      // One atomic statement: only a confirmed appointment changes. Two simultaneous cancels cannot
      // both win, and the loser sees the winner's record unchanged.
      const changed = await db
        .updateTable('appointment')
        .set({ status: 'cancelled', cancelled_at: clock() })
        .where('id', '=', id)
        .where('status', '=', 'confirmed')
        .returning('id')
        .executeTakeFirst();

      const appointment = await findAppointmentById(db, id);
      if (!appointment) throw new AppError('NOT_FOUND', 'No appointment exists with that ID');

      log.info(
        { outcome: changed ? 'cancelled' : 'already_cancelled', appointmentId: appointment.id },
        changed ? 'Appointment cancelled' : 'Appointment was already cancelled',
      );
      return appointment;
    },
  };
}
