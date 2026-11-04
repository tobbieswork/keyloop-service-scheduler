import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

/**
 * Error codes and their HTTP statuses. This is the single source for the table in
 * specs/001-service-scheduler/research.md (decision 8) and the error enum in the OpenAPI contract.
 * Rule of thumb: 400 = the request is malformed, 422 = well-formed but breaks a business rule.
 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  SLOT_UNAVAILABLE: 409,
  RESOURCE_HAS_APPOINTMENTS: 409,
  UNAVAILABILITY_OVERLAP: 409,
  OUTSIDE_WORKING_HOURS: 422,
  START_IN_PAST: 422,
  VEHICLE_CUSTOMER_MISMATCH: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorOptions {
  /** Extra detail inside `error.details`. Must never contain personal data. */
  details?: Record<string, unknown>;
  /** Extra top-level fields beside `error`, e.g. `alternatives` on a capacity conflict. */
  extra?: Record<string, unknown>;
}

/** A business or request error that maps to a known code and HTTP status. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly extra: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = options.details;
    this.extra = options.extra;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId: string; details?: Record<string, unknown> };
  [extra: string]: unknown;
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  code: ErrorCode,
  message: string,
  options: ErrorOptions = {},
): FastifyReply {
  const body: ErrorBody = {
    ...options.extra,
    error: {
      code,
      message,
      requestId: request.id,
      ...(options.details ? { details: options.details } : {}),
    },
  };
  return reply.status(ERROR_STATUS[code]).send(body);
}

/**
 * Install the uniform error handling: every failure leaves the service as
 * `{ error: { code, message, requestId, details? } }`.
 *
 * Privacy rules: validation details name the failing field but never echo the submitted value,
 * and unexpected errors return a generic message (the real error is logged with the request ID).
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => send(reply, request, 'NOT_FOUND', 'Route not found'));

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      return send(reply, request, error.code, error.message, {
        ...(error.details && { details: error.details }),
        ...(error.extra && { extra: error.extra }),
      });
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((issue) => ({
        path: `${error.validationContext ?? 'request'}${issue.instancePath}`,
        message: issue.message ?? 'Invalid value',
      }));
      return send(reply, request, 'VALIDATION_ERROR', 'Request validation failed', {
        details: { issues },
      });
    }

    if (isResponseSerializationError(error)) {
      // Our own response broke its schema: a programming error, never the caller's fault.
      request.log.error({ err: error }, 'Response failed schema serialization');
      return send(reply, request, 'INTERNAL_ERROR', 'Internal server error');
    }

    const statusCode = (error as FastifyError).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      // Malformed JSON, wrong content type, body too large, and so on. The framework's own message
      // is deliberately not echoed. Fastify 5 does not quote the body today, but that wording is
      // outside our control and can change between versions, so the response stays fixed.
      return send(reply, request, 'VALIDATION_ERROR', 'Malformed request');
    }

    request.log.error({ err: error }, 'Unhandled error');
    return send(reply, request, 'INTERNAL_ERROR', 'Internal server error');
  });
}
