import type { FastifyInstance } from 'fastify';

const JSON_TYPE = /^application\/json\b/i;

/**
 * Accept a request that declares `Content-Type: application/json` but carries no body.
 *
 * Plenty of clients do this for a POST with nothing to send (curl with a header, axios, fetch
 * wrappers), for example "cancel this appointment". Fastify's JSON parser rejects it as a
 * malformed body, which would make a perfectly normal request fail with a confusing 400.
 *
 * Rather than replace the JSON parser (the default one also refuses prototype-poisoning payloads
 * such as `{"__proto__": ...}`), the declared content type is dropped from requests that really
 * are empty. A route that REQUIRES a body still answers 400 VALIDATION_ERROR, because its body
 * schema then sees no body at all.
 */
export function acceptEmptyJsonBodies(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    const contentType = request.headers['content-type'];
    if (!contentType || !JSON_TYPE.test(contentType)) return;
    const length = request.headers['content-length'];
    const chunked = request.headers['transfer-encoding'] !== undefined;
    if (!chunked && (length === undefined || length === '0')) {
      delete request.headers['content-type'];
    }
  });
}
