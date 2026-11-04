import type { FastifyInstance } from 'fastify';
import type { Metrics } from './metrics.js';

/**
 * Add the observability behaviour to an app:
 *  - an `x-request-id` header on every response (including errors),
 *  - a request duration histogram labelled by route pattern, and
 *  - `GET /metrics` in the Prometheus text format.
 */
export function registerObservability(app: FastifyInstance, metrics: Metrics): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    // Unknown URLs share one label, so scanners cannot create endless metric series or put
    // identifiers from a URL into the metrics.
    const route = request.is404 ? 'unmatched' : (request.routeOptions.url ?? 'unmatched');
    metrics.httpDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/metrics', async (_request, reply) => {
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
}
