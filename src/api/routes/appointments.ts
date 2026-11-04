import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/index.js';
import { findAppointmentById } from '../../db/repositories/appointments.js';
import type { BookingService } from '../../services/booking.js';
import type { CancelService } from '../../services/cancel.js';
import { AppError } from '../errors.js';
import {
  appointmentSchema,
  bookingBodySchema,
  idempotencyHeaderSchema,
  idParamsSchema,
  toAppointmentDto,
} from '../schemas.js';

export interface AppointmentRouteDeps {
  db: Db;
  booking: BookingService;
  cancel: CancelService;
}

export function registerAppointmentRoutes(app: FastifyInstance, deps: AppointmentRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/appointments',
    {
      schema: {
        summary: 'Book an appointment (the system assigns the bay and technician)',
        headers: idempotencyHeaderSchema,
        body: bookingBodySchema,
        response: { 200: appointmentSchema, 201: appointmentSchema },
      },
    },
    async (request, reply) => {
      const { body } = request;
      const outcome = await deps.booking.book(
        {
          customerId: body.customerId,
          vehicleId: body.vehicleId,
          serviceTypeId: body.serviceTypeId,
          dealershipId: body.dealershipId,
          startTime: new Date(body.startTime),
          idempotencyKey: request.headers['idempotency-key'],
        },
        request.log,
      );
      const dto = toAppointmentDto(outcome.appointment);
      if (outcome.replayed) {
        return reply.header('Idempotent-Replayed', 'true').status(200).send(dto);
      }
      return reply.status(201).send(dto);
    },
  );

  typed.post(
    '/appointments/:id/cancel',
    {
      schema: {
        summary: 'Cancel an appointment (idempotent; the record is kept)',
        params: idParamsSchema,
        response: { 200: appointmentSchema },
      },
    },
    async (request) => toAppointmentDto(await deps.cancel.cancel(request.params.id, request.log)),
  );

  typed.get(
    '/appointments/:id',
    {
      schema: {
        summary: 'Retrieve an appointment, including cancelled ones',
        params: idParamsSchema,
        response: { 200: appointmentSchema },
      },
    },
    async (request) => {
      const appointment = await findAppointmentById(deps.db, request.params.id);
      if (!appointment) throw new AppError('NOT_FOUND', 'No appointment exists with that ID');
      return toAppointmentDto(appointment);
    },
  );
}
