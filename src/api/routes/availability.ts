import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../db/index.js';
import { listDealerships, listServiceTypes } from '../../db/repositories/availability.js';
import type { AvailabilityService } from '../../services/availability.js';
import { id } from '../schemas.js';

const slotSchema = z.object({ startTime: z.string(), endTime: z.string() });

export function registerAvailabilityRoutes(
  app: FastifyInstance,
  deps: { db: Db; availability: AvailabilityService },
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/availability',
    {
      schema: {
        summary: 'List bookable start times for a service type on a date',
        querystring: z.object({
          dealershipId: id,
          serviceTypeId: id,
          date: z.iso.date(), // the dealership-local calendar date
        }),
        response: { 200: z.object({ slots: z.array(slotSchema) }) },
      },
    },
    async (request) => {
      const slots = await deps.availability.slotsForDay(request.query);
      return {
        slots: slots.map((s) => ({
          startTime: s.startTime.toISOString(),
          endTime: s.endTime.toISOString(),
        })),
      };
    },
  );

  typed.get(
    '/dealerships',
    {
      schema: {
        summary: 'List dealerships (reference data for clients)',
        response: {
          200: z.array(z.object({ id: z.string(), name: z.string(), timeZone: z.string() })),
        },
      },
    },
    async () => listDealerships(deps.db),
  );

  typed.get(
    '/service-types',
    {
      schema: {
        summary: 'List service types (reference data for clients)',
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              durationMinutes: z.number(),
              bufferMinutes: z.number(),
            }),
          ),
        },
      },
    },
    async () => listServiceTypes(deps.db),
  );
}
