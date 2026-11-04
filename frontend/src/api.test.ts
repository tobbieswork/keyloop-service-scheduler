import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, createApiClient, type BookingInput } from './api';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const appointment = {
  id: 'a1',
  customerId: 'c1',
  vehicleId: 'v1',
  serviceTypeId: 's1',
  dealershipId: 'd1',
  bayId: 'b1',
  technicianId: 't1',
  startTime: '2030-03-04T09:00:00.000Z',
  serviceEndTime: '2030-03-04T10:00:00.000Z',
  occupiedUntil: '2030-03-04T10:15:00.000Z',
  status: 'confirmed',
  cancelledAt: null,
};

const input: BookingInput = {
  customerId: 'c1',
  vehicleId: 'v1',
  serviceTypeId: 's1',
  dealershipId: 'd1',
  startTime: '2030-03-04T09:00:00.000Z',
};

/** A client whose fetch returns the given response once, and a handle to inspect the call. */
function clientReturning(response: Response | Error) {
  const fetchImpl = vi.fn(async () => {
    if (!(response instanceof Response)) throw response; // an Error or DOMException to throw
    return response;
  });
  return { api: createApiClient(fetchImpl as unknown as typeof fetch, '/api'), fetchImpl };
}
const lastCall = (fetchImpl: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit | undefined];
  return { url, init: init ?? {} };
};

describe('reading', () => {
  it('loads dealerships and service types', async () => {
    const { api, fetchImpl } = clientReturning(
      json(200, [{ id: 'd1', name: 'London', timeZone: 'Europe/London' }]),
    );
    expect(await api.dealerships()).toEqual([
      { id: 'd1', name: 'London', timeZone: 'Europe/London' },
    ]);
    expect(lastCall(fetchImpl).url).toBe('/api/dealerships');
    const second = clientReturning(
      json(200, [{ id: 's1', name: 'Brakes', durationMinutes: 90, bufferMinutes: 15 }]),
    );
    expect((await second.api.serviceTypes())[0]?.durationMinutes).toBe(90);
    expect(lastCall(second.fetchImpl).url).toBe('/api/service-types');
  });

  it('asks for availability with the three choices in the query string and returns the slots', async () => {
    const slots = [{ startTime: '2030-03-04T09:00:00.000Z', endTime: '2030-03-04T10:15:00.000Z' }];
    const { api, fetchImpl } = clientReturning(json(200, { slots }));
    const result = await api.availability({
      dealershipId: 'd 1',
      serviceTypeId: 's1',
      date: '2030-03-04',
    });
    expect(result).toEqual(slots);
    const { url } = lastCall(fetchImpl);
    expect(url).toBe('/api/availability?dealershipId=d+1&serviceTypeId=s1&date=2030-03-04');
  });

  it('passes an abort signal through so a stale request can be cancelled', async () => {
    const { api, fetchImpl } = clientReturning(json(200, { slots: [] }));
    const controller = new AbortController();
    await api.availability(
      { dealershipId: 'd1', serviceTypeId: 's1', date: '2030-03-04' },
      controller.signal,
    );
    expect(lastCall(fetchImpl).init.signal).toBe(controller.signal);
  });
});

describe('booking', () => {
  it('sends the request as JSON with the Idempotency-Key header', async () => {
    const { api, fetchImpl } = clientReturning(json(201, appointment));
    await api.book(input, 'key-12345678');
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe('/api/appointments');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Idempotency-Key': 'key-12345678',
    });
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('reports a new booking (201) and a replay (200) differently', async () => {
    expect(await clientReturning(json(201, appointment)).api.book(input, 'k-1234567')).toEqual({
      appointment,
      replayed: false,
    });
    expect(
      (await clientReturning(json(200, appointment)).api.book(input, 'k-1234567')).replayed,
    ).toBe(true);
  });

  it('cancels with a POST and no body', async () => {
    const { api, fetchImpl } = clientReturning(json(200, { ...appointment, status: 'cancelled' }));
    const result = await api.cancel('a1');
    expect(result.status).toBe('cancelled');
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe('/api/appointments/a1/cancel');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
});

describe('API errors', () => {
  const apiError = async (promise: Promise<unknown>) =>
    (await promise.catch((e: unknown) => e)) as ApiError;

  it('carries the HTTP status, code, message and request ID', async () => {
    const { api } = clientReturning(
      json(422, {
        error: {
          code: 'OUTSIDE_WORKING_HOURS',
          message: 'The dealership is closed that day',
          requestId: 'req-9',
          details: { reason: 'CLOSED_DAY' },
        },
      }),
    );
    const error = await apiError(api.book(input, 'k-1234567'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'OUTSIDE_WORKING_HOURS',
      message: 'The dealership is closed that day',
      requestId: 'req-9',
      details: { reason: 'CLOSED_DAY' },
      alternatives: [],
    });
  });

  it('keeps the alternatives of a 409', async () => {
    const alternatives = [
      { startTime: '2030-03-04T10:00:00.000Z', endTime: '2030-03-04T11:15:00.000Z' },
    ];
    const { api } = clientReturning(
      json(409, {
        error: { code: 'SLOT_UNAVAILABLE', message: 'No capacity', requestId: 'req-1' },
        alternatives,
      }),
    );
    const error = await apiError(api.book(input, 'k-1234567'));
    expect(error.code).toBe('SLOT_UNAVAILABLE');
    expect(error.alternatives).toEqual(alternatives);
  });

  it('turns a non-JSON error (a proxy or gateway page) into an ApiError, using the request-id header', async () => {
    const { api } = clientReturning(
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html', 'x-request-id': 'edge-7' },
      }),
    );
    const error = await apiError(api.dealerships());
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: 'UNEXPECTED_RESPONSE', requestId: 'edge-7' });
    expect(error.message).toContain('502');
  });

  it('treats a JSON body of the wrong shape as an unexpected response, not a crash', async () => {
    const { api } = clientReturning(json(500, { oops: true }));
    const error = await apiError(api.dealerships());
    expect(error).toMatchObject({ status: 500, code: 'UNEXPECTED_RESPONSE' });
  });
});

describe('network failures', () => {
  it('is a NetworkError, distinct from an API error', async () => {
    const { api } = clientReturning(new TypeError('Failed to fetch'));
    const error = await api
      .availability({ dealershipId: 'd1', serviceTypeId: 's1', date: '2030-03-04' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('lets an abort through untouched, so callers can ignore it', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const { api } = clientReturning(abort);
    const error = await api.dealerships().catch((e: unknown) => e);
    expect(error).toBe(abort);
  });
});
