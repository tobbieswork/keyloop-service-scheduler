import { describe, expect, it } from 'vitest';
import { ERROR_STATUS } from '../../src/api/errors.js';
import {
  assertMatchesContract,
  contractErrorCodes,
  ContractViolation,
  type ContractResponse,
} from '../contract/helpers.js';

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2030-03-04T09:00:00.000Z';

const appointment = {
  id: ID,
  customerId: ID,
  vehicleId: ID,
  serviceTypeId: ID,
  dealershipId: ID,
  bayId: ID,
  technicianId: ID,
  startTime: NOW,
  serviceEndTime: '2030-03-04T10:00:00.000Z',
  occupiedUntil: '2030-03-04T10:15:00.000Z',
  status: 'confirmed',
  cancelledAt: null,
};

const json = (
  statusCode: number,
  body: unknown,
  contentType = 'application/json; charset=utf-8',
): ContractResponse => ({
  statusCode,
  headers: { 'content-type': contentType },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const err = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: 'x', requestId: 'r-1' },
  ...extra,
});

const book = { method: 'POST', path: '/appointments' } as const;

describe('assertMatchesContract: accepts valid responses', () => {
  it('a 201 appointment, including a null cancelledAt', () => {
    expect(() => assertMatchesContract(json(201, appointment), book)).not.toThrow();
  });

  it('a cancelled appointment with a cancelledAt timestamp', () => {
    const cancelled = { ...appointment, status: 'cancelled', cancelledAt: NOW };
    expect(() =>
      assertMatchesContract(json(200, cancelled), {
        method: 'POST',
        path: '/appointments/{id}/cancel',
      }),
    ).not.toThrow();
  });

  it('a 409 conflict with alternatives, through allOf and $ref', () => {
    const body = err('SLOT_UNAVAILABLE', { alternatives: [{ startTime: NOW, endTime: NOW }] });
    expect(() => assertMatchesContract(json(409, body), book)).not.toThrow();
  });

  it('a 400 validation error with details', () => {
    const body = { error: { ...err('VALIDATION_ERROR').error, details: { issues: [] } } };
    expect(() => assertMatchesContract(json(400, body), book)).not.toThrow();
  });

  it('the operational endpoints', () => {
    expect(() =>
      assertMatchesContract(json(200, { status: 'ok' }), { method: 'GET', path: '/health' }),
    ).not.toThrow();
    expect(() =>
      assertMatchesContract(json(503, { status: 'unavailable' }), {
        method: 'GET',
        path: '/ready',
      }),
    ).not.toThrow();
    expect(() =>
      assertMatchesContract(json(200, '# HELP x\n', 'text/plain; version=0.0.4'), {
        method: 'GET',
        path: '/metrics',
      }),
    ).not.toThrow();
  });

  it('a 500 on any endpoint, via the default response', () => {
    expect(() =>
      assertMatchesContract(json(500, err('INTERNAL_ERROR')), {
        method: 'GET',
        path: '/availability',
      }),
    ).not.toThrow();
  });

  it('extra properties the contract does not mention (OpenAPI allows them)', () => {
    expect(() =>
      assertMatchesContract(json(201, { ...appointment, extra: 1 }), book),
    ).not.toThrow();
  });
});

describe('assertMatchesContract: rejects violations', () => {
  const rejects = (response: ContractResponse, op = book, pattern?: RegExp) => {
    try {
      assertMatchesContract(response, op);
    } catch (error) {
      expect(error).toBeInstanceOf(ContractViolation);
      if (pattern) expect((error as Error).message).toMatch(pattern);
      return;
    }
    expect.unreachable('expected a ContractViolation');
  };

  it('a missing required field, naming it', () => {
    const { technicianId: _omit, ...rest } = appointment;
    rejects(json(201, rest), book, /technicianId/);
  });

  it('a value outside an enum', () => {
    rejects(json(201, { ...appointment, status: 'done' }), book, /status/);
  });

  it('a wrong type', () => {
    rejects(json(201, { ...appointment, startTime: 12345 }), book, /startTime/);
  });

  it('a bad uuid and a bad timestamp (formats are enforced)', () => {
    rejects(json(201, { ...appointment, bayId: 'not-a-uuid' }), book, /bayId/);
    rejects(json(201, { ...appointment, startTime: 'yesterday-ish' }), book, /startTime/);
  });

  it('more than 5 alternatives', () => {
    const six = Array.from({ length: 6 }, () => ({ startTime: NOW, endTime: NOW }));
    rejects(json(409, err('SLOT_UNAVAILABLE', { alternatives: six })), book, /alternatives/);
  });

  it('a status code the contract does not document for that endpoint', () => {
    rejects(json(409, err('SLOT_UNAVAILABLE')), { method: 'GET', path: '/availability' }, /409/);
  });

  it('an undocumented 4xx even when its body looks like a valid error (default covers 5xx only)', () => {
    rejects(json(418, err('VALIDATION_ERROR')), book, /418/);
  });

  it('the wrong content type', () => {
    rejects(json(201, appointment, 'text/html'), book, /content-type/i);
  });

  it('a body that is not JSON', () => {
    rejects(json(201, 'definitely not json'), book, /JSON/);
  });

  it('an unknown path or method', () => {
    rejects(json(200, {}), { method: 'GET', path: '/nope' } as never, /\/nope/);
    rejects(json(200, {}), { method: 'DELETE', path: '/appointments' } as never, /DELETE/);
  });

  it('an error code that does not belong to the status code', () => {
    // Valid against the schema (the code is in the enum) but wrong: VALIDATION_ERROR is 400, not 409.
    rejects(json(409, err('VALIDATION_ERROR')), book, /VALIDATION_ERROR/);
  });

  it('a response with an empty body when the contract expects JSON', () => {
    rejects(json(201, ''), book);
  });
});

describe('contract and code stay in step', () => {
  it('the error codes in the contract are exactly the codes in the status table', () => {
    expect([...contractErrorCodes()].sort()).toEqual(Object.keys(ERROR_STATUS).sort());
  });
});
