import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ResourceKind } from '../../db/repositories/unavailability.js';
import type { UnavailabilityService } from '../../services/unavailability.js';
import { idParamsSchema } from '../schemas.js';

const bodySchema = z
  .object({
    startTime: z.iso.datetime({ offset: true }),
    endTime: z.iso.datetime({ offset: true }),
    reason: z.string().min(1).max(200),
  })
  .refine((b) => new Date(b.endTime).getTime() > new Date(b.startTime).getTime(), {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

const unavailabilitySchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  reason: z.string(),
});

export function registerUnavailabilityRoutes(
  app: FastifyInstance,
  deps: { unavailability: UnavailabilityService },
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const routes: { kind: ResourceKind; url: string; summary: string }[] = [
    {
      kind: 'bay',
      url: '/bays/:id/unavailability',
      summary: 'Mark a bay unavailable for a time range',
    },
    {
      kind: 'technician',
      url: '/technicians/:id/unavailability',
      summary: 'Mark a technician unavailable for a time range',
    },
  ];

  for (const { kind, url, summary } of routes) {
    typed.post(
      url,
      {
        schema: {
          summary,
          params: idParamsSchema,
          body: bodySchema,
          response: { 201: unavailabilitySchema },
        },
      },
      async (request, reply) => {
        const record = await deps.unavailability.block(
          kind,
          request.params.id,
          {
            start: new Date(request.body.startTime),
            end: new Date(request.body.endTime),
            reason: request.body.reason,
          },
          request.log,
        );
        return reply.status(201).send({
          id: record.id,
          resourceId: record.resourceId,
          startTime: record.startTime.toISOString(),
          endTime: record.endTime.toISOString(),
          reason: record.reason,
        });
      },
    );
  }
}
