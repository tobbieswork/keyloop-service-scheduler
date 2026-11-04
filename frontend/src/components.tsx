import {
  ApiError,
  NetworkError,
  type Appointment,
  type Dealership,
  type ServiceType,
  type Slot,
} from './api';
import type { DemoCustomer } from './demoData';
import { formatDateTime, formatTime } from './time';

/** An error the user can act on: the message, and the request ID so it can be found in the logs. */
export function ErrorNotice({ error }: { error: unknown }) {
  const requestId = error instanceof ApiError ? error.requestId : '';
  const message =
    error instanceof NetworkError || error instanceof ApiError
      ? error.message
      : 'Something went wrong. Please try again.';
  return (
    <div role="alert" className="notice notice-error">
      <p>{message}</p>
      {requestId && <p className="reference">Reference: {requestId}</p>}
    </div>
  );
}

export function SlotList({
  slots,
  timeZone,
  disabled,
  onChoose,
}: {
  slots: Slot[];
  timeZone: string;
  disabled: boolean;
  onChoose: (slot: Slot) => void;
}) {
  return (
    <ul className="slots">
      {slots.map((slot) => (
        <li key={slot.startTime}>
          <button type="button" disabled={disabled} onClick={() => onChoose(slot)}>
            {formatTime(slot.startTime, timeZone)}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Alternatives({
  slots,
  timeZone,
  onChoose,
}: {
  slots: Slot[];
  timeZone: string;
  onChoose: (slot: Slot) => void;
}) {
  if (slots.length === 0) {
    return <p>Nothing else is free in the next days.</p>;
  }
  return (
    <div>
      <p>Other times you could book:</p>
      <ul className="slots">
        {slots.map((slot) => (
          <li key={slot.startTime}>
            <button type="button" onClick={() => onChoose(slot)}>
              {formatDateTime(slot.startTime, timeZone)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ConfirmPanel({
  slot,
  dealership,
  service,
  customers,
  customerId,
  vehicleId,
  pending,
  onCustomer,
  onVehicle,
  onBook,
  onBack,
}: {
  slot: Slot;
  dealership: Dealership;
  service: ServiceType;
  customers: DemoCustomer[];
  customerId: string;
  vehicleId: string;
  pending: boolean;
  onCustomer: (id: string) => void;
  onVehicle: (id: string) => void;
  onBook: () => void;
  onBack: () => void;
}) {
  const customer = customers.find((c) => c.id === customerId);
  return (
    <section aria-label="Confirm booking" className="panel">
      <h2>Confirm booking</h2>
      <p>
        {service.name} at {dealership.name} on {formatDateTime(slot.startTime, dealership.timeZone)}
      </p>
      <p className="hint">Customer and vehicle come from SAMPLE data for this demo.</p>
      <div className="field">
        <label htmlFor="customer">Customer (demo data)</label>
        <select
          id="customer"
          value={customerId}
          disabled={pending}
          onChange={(e) => onCustomer(e.target.value)}
        >
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="vehicle">Vehicle (demo data)</label>
        <select
          id="vehicle"
          value={vehicleId}
          disabled={pending}
          onChange={(e) => onVehicle(e.target.value)}
        >
          {(customer?.vehicles ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={pending} onClick={onBook}>
          {pending ? 'Booking…' : 'Book this time'}
        </button>
        <button type="button" disabled={pending} onClick={onBack}>
          Choose a different time
        </button>
      </div>
    </section>
  );
}

export function SessionBookings({
  bookings,
  dealerships,
  serviceTypes,
  cancelling,
  onCancel,
}: {
  bookings: Appointment[];
  dealerships: Dealership[];
  serviceTypes: ServiceType[];
  cancelling: string | null;
  onCancel: (id: string) => void;
}) {
  return (
    <section aria-labelledby="bookings-heading">
      <h2 id="bookings-heading">Your bookings this session</h2>
      <p className="hint">
        This session only: reloading the page clears this list, because the service has no endpoint
        that lists bookings.
      </p>
      {bookings.length === 0 ? (
        <p>No bookings yet.</p>
      ) : (
        <ul aria-label="Your bookings this session" className="bookings">
          {bookings.map((b) => {
            const dealership = dealerships.find((d) => d.id === b.dealershipId);
            const service = serviceTypes.find((s) => s.id === b.serviceTypeId);
            const when = formatDateTime(b.startTime, dealership?.timeZone ?? 'UTC');
            return (
              <li key={b.id}>
                <span className="when">{when}</span>
                <span>
                  {service?.name ?? 'Service'} at {dealership?.name ?? 'dealership'}
                </span>
                <span className={`status status-${b.status}`}>
                  {b.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
                </span>
                {b.status === 'confirmed' && (
                  <button
                    type="button"
                    aria-label={`Cancel booking ${when}`}
                    disabled={cancelling === b.id}
                    onClick={() => onCancel(b.id)}
                  >
                    {cancelling === b.id ? 'Cancelling…' : 'Cancel booking'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
