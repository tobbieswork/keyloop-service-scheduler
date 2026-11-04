/** A small, typed client for the scheduler API. No UI code in here. */

export interface Dealership {
  id: string;
  name: string;
  timeZone: string;
}
export interface ServiceType {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
}
export interface Slot {
  startTime: string;
  endTime: string;
}
export interface Appointment {
  id: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  dealershipId: string;
  bayId: string;
  technicianId: string;
  startTime: string;
  serviceEndTime: string;
  occupiedUntil: string;
  status: 'confirmed' | 'cancelled';
  cancelledAt: string | null;
}
export interface BookingInput {
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  dealershipId: string;
  /** ISO 8601 instant, taken from an availability slot. */
  startTime: string;
}
export interface BookingResult {
  appointment: Appointment;
  /** True when the API recognised the Idempotency-Key and returned an earlier booking. */
  replayed: boolean;
}

/** The API answered, but with an error. `requestId` can be searched for in the service's logs. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly details: Record<string, unknown> | undefined = undefined,
    /** Other times to try, present on a 409 SLOT_UNAVAILABLE. */
    readonly alternatives: Slot[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The API could not be reached at all (offline, server down, blocked). Safe to retry. */
export class NetworkError extends Error {
  constructor() {
    super('Cannot reach the booking service. Check your connection and try again.');
    this.name = 'NetworkError';
  }
}

export interface AvailabilityQuery {
  dealershipId: string;
  serviceTypeId: string;
  /** The dealership-local calendar date, YYYY-MM-DD. */
  date: string;
}

export interface ApiClient {
  dealerships(signal?: AbortSignal): Promise<Dealership[]>;
  serviceTypes(signal?: AbortSignal): Promise<ServiceType[]>;
  availability(query: AvailabilityQuery, signal?: AbortSignal): Promise<Slot[]>;
  book(input: BookingInput, idempotencyKey: string): Promise<BookingResult>;
  cancel(appointmentId: string): Promise<Appointment>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function createApiClient(
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  baseUrl = '/api',
): ApiClient {
  async function send(
    path: string,
    init: RequestInit = {},
  ): Promise<{ response: Response; body: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (error) {
      // An abort is the caller's own doing (a newer request replaced this one): pass it through.
      if (isObject(error) && error['name'] === 'AbortError') throw error;
      throw new NetworkError();
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined; // not JSON, for example an HTML error page from a proxy
    }
    if (!response.ok) throw toApiError(response, body);
    return { response, body };
  }

  return {
    async dealerships(signal) {
      return (await send('/dealerships', { signal })).body as Dealership[];
    },
    async serviceTypes(signal) {
      return (await send('/service-types', { signal })).body as ServiceType[];
    },
    async availability(query, signal) {
      const params = new URLSearchParams({
        dealershipId: query.dealershipId,
        serviceTypeId: query.serviceTypeId,
        date: query.date,
      });
      const { body } = await send(`/availability?${params.toString()}`, { signal });
      return (body as { slots: Slot[] }).slots;
    },
    async book(input, idempotencyKey) {
      const { response, body } = await send('/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      });
      return { appointment: body as Appointment, replayed: response.status === 200 };
    },
    async cancel(appointmentId) {
      const { body } = await send(`/appointments/${encodeURIComponent(appointmentId)}/cancel`, {
        method: 'POST',
      });
      return body as Appointment;
    },
  };
}

function toApiError(response: Response, body: unknown): ApiError {
  const headerId = response.headers.get('x-request-id') ?? '';
  const error = isObject(body) && isObject(body['error']) ? body['error'] : undefined;
  if (error && typeof error['code'] === 'string' && typeof error['message'] === 'string') {
    return new ApiError(
      response.status,
      error['code'],
      error['message'],
      typeof error['requestId'] === 'string' ? error['requestId'] : headerId,
      isObject(error['details']) ? error['details'] : undefined,
      isObject(body) && Array.isArray(body['alternatives']) ? (body['alternatives'] as Slot[]) : [],
    );
  }
  return new ApiError(
    response.status,
    'UNEXPECTED_RESPONSE',
    `The service returned an unexpected response (HTTP ${response.status}).`,
    headerId,
  );
}
