import { LogController, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

/** Request IDs from callers are kept only if they are short and made of safe characters. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Use the caller's `x-request-id` when it is safe, otherwise make a new UUID. An unchecked ID
 * could be huge, or contain a newline plus fake JSON to forge a log line.
 */
export function generateRequestId(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const header = req.headers['x-request-id'];
  const first = Array.isArray(header) ? header[0] : header;
  return first !== undefined && SAFE_REQUEST_ID.test(first) ? first : randomUUID();
}

/**
 * Log only what is needed to debug: the method and the path. Headers (Authorization, cookies),
 * the query string and the body never reach the logs, so personal data cannot leak through them.
 */
const requestSerializer = (req: { method?: string; url?: string }) => ({
  method: req.method,
  url: req.url?.split('?')[0],
});

const responseSerializer = (res: { statusCode?: number }) => ({ statusCode: res.statusCode });

/**
 * Keep the error type, message, stack and the database identifiers needed to debug
 * (`code`, `constraint`, `table`). Drop everything else: node-postgres puts the offending VALUES
 * in `detail` and `parameters`, which can be a VIN, a name or a contact.
 *
 * Residual risk: a few database messages quote a value (for example an invalid uuid). Input
 * validation rejects those before they reach the database.
 */
export function errorSerializer(err: unknown) {
  if (!(err instanceof Error)) return { type: 'NonError', message: String(err), stack: '' };
  const e = err as Error & { code?: unknown; constraint?: unknown; table?: unknown };
  return {
    type: e.name,
    message: e.message,
    stack: e.stack ?? '',
    ...(typeof e.code === 'string' && { code: e.code }),
    ...(typeof e.constraint === 'string' && { constraint: e.constraint }),
    ...(typeof e.table === 'string' && { table: e.table }),
  };
}

/** Fastify options that give every log line a request ID and keep personal data out of the logs. */
export function observabilityServerOptions(level: string, stream?: Writable): FastifyServerOptions {
  return {
    logger: {
      level,
      serializers: { req: requestSerializer, res: responseSerializer, err: errorSerializer },
      ...(stream && { stream }),
    },
    genReqId: generateRequestId,
    requestIdHeader: false, // genReqId reads the header itself, with validation
    // Name the request ID field `reqId` on every log line. (The top-level `requestIdLogLabel`
    // option is deprecated and will be removed in Fastify 6.)
    logController: new LogController({ requestIdLogLabel: 'reqId' }),
  };
}
