import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type ApiClient,
  type Appointment,
  type Dealership,
  type ServiceType,
  type Slot,
} from './api';
import { Alternatives, ConfirmPanel, ErrorNotice, SessionBookings, SlotList } from './components';
import { demoCustomers, type DemoCustomer } from './demoData';
import { formatDateTime, tomorrowIn } from './time';

export interface AppProps {
  api: ApiClient;
  /** Injectable for tests. */
  now?: () => Date;
  /** A fresh idempotency key. Injectable for tests. */
  newKey?: () => string;
  customers?: DemoCustomer[];
}

type Reference = { dealerships: Dealership[]; serviceTypes: ServiceType[] };
type Availability =
  | { status: 'loading' }
  | { status: 'ready'; slots: Slot[] }
  /** The same question is being asked again (after a booking or cancel): keep the old list meanwhile. */
  | { status: 'refreshing'; slots: Slot[] }
  | { status: 'error'; error: unknown };

/** One attempt to book one time. The key stays the same for retries of THIS attempt only. */
interface Attempt {
  slot: Slot;
  key: string;
}

export function App({
  api,
  now = () => new Date(),
  newKey = () => crypto.randomUUID(),
  customers = demoCustomers,
}: AppProps) {
  // ---- reference data (dealerships and service types) ----
  const [reference, setReference] = useState<Reference | undefined>();
  const [referenceError, setReferenceError] = useState<unknown>();
  const [referenceTick, setReferenceTick] = useState(0);

  // ---- what the user is looking for ----
  const [dealershipId, setDealershipId] = useState('');
  const [serviceTypeId, setServiceTypeId] = useState('');
  const [date, setDate] = useState('');

  // ---- the times on offer ----
  const [availability, setAvailability] = useState<Availability>({ status: 'loading' });
  const [availabilityTick, setAvailabilityTick] = useState(0);
  const refreshTimes = useCallback(() => setAvailabilityTick((t) => t + 1), []);

  // ---- booking ----
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [vehicleId, setVehicleId] = useState(customers[0]?.vehicles[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<
    { kind: 'error'; error: unknown } | { kind: 'result'; text: string } | undefined
  >();
  const [alternatives, setAlternatives] = useState<Slot[] | undefined>();
  const [bookings, setBookings] = useState<Appointment[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);

  // Load dealerships and service types, and pick the defaults.
  useEffect(() => {
    const controller = new AbortController();
    setReferenceError(undefined);
    Promise.all([api.dealerships(controller.signal), api.serviceTypes(controller.signal)])
      .then(([dealerships, serviceTypes]) => {
        setReference({ dealerships, serviceTypes });
        const first = dealerships[0];
        setDealershipId((current) => current || first?.id || '');
        setServiceTypeId((current) => current || serviceTypes[0]?.id || '');
        if (first) setDate((current) => current || tomorrowIn(first.timeZone, now()));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setReferenceError(error);
      });
    return () => controller.abort();
    // `now` is stable for the life of the app; the others only change on retry.
  }, [api, referenceTick]);

  // Load the times whenever the choice changes. A newer request cancels the older one, so a slow
  // answer can never overwrite a fresher one.
  const latest = useRef(0);
  const lastQuery = useRef('');
  useEffect(() => {
    if (!dealershipId || !serviceTypeId || !date) return;
    const controller = new AbortController();
    const id = ++latest.current;
    // The same question again (only the refresh counter changed): keep the old times on screen,
    // so the list does not vanish and reappear. A different question (a new date, dealership or
    // service) must NOT show the old times, because they would be for the wrong thing.
    const queryKey = `${dealershipId}|${serviceTypeId}|${date}`;
    const sameQuestion = lastQuery.current === queryKey;
    lastQuery.current = queryKey;
    setAvailability((previous) =>
      sameQuestion && (previous.status === 'ready' || previous.status === 'refreshing')
        ? { status: 'refreshing', slots: previous.slots }
        : { status: 'loading' },
    );
    api
      .availability({ dealershipId, serviceTypeId, date }, controller.signal)
      .then((slots) => {
        if (id === latest.current) setAvailability({ status: 'ready', slots });
      })
      .catch((error: unknown) => {
        if (id === latest.current && !controller.signal.aborted)
          setAvailability({ status: 'error', error });
      });
    return () => controller.abort();
  }, [api, dealershipId, serviceTypeId, date, availabilityTick]);

  const dealership = reference?.dealerships.find((d) => d.id === dealershipId);
  const service = reference?.serviceTypes.find((s) => s.id === serviceTypeId);

  const openAttempt = (slot: Slot) => {
    setAttempt({ slot, key: newKey() }); // a new time is a new request, so a new key
    setNotice(undefined);
    setAlternatives(undefined);
  };

  const book = async () => {
    if (!attempt || !dealership || !service) return;
    setPending(true);
    setNotice(undefined);
    setAlternatives(undefined);
    try {
      const { appointment, replayed } = await api.book(
        {
          customerId,
          vehicleId,
          serviceTypeId: service.id,
          dealershipId: dealership.id,
          startTime: attempt.slot.startTime,
        },
        attempt.key,
      );
      const when = formatDateTime(appointment.startTime, dealership.timeZone);
      setBookings((list) =>
        list.some((b) => b.id === appointment.id) ? list : [...list, appointment],
      );
      setNotice({
        kind: 'result',
        text: replayed
          ? `Already booked: ${when} at ${dealership.name}. This request had already been received, so no second booking was made.`
          : `Booked: ${when} at ${dealership.name}.`,
      });
      setAttempt(undefined);
      refreshTimes();
    } catch (error) {
      // Keep the confirmation open: the key is kept too, so pressing Book again is a safe retry.
      setNotice({ kind: 'error', error });
      if (error instanceof ApiError && error.code === 'SLOT_UNAVAILABLE') {
        // That time is gone: booking it again could only fail, so close the confirmation and
        // offer the alternatives instead. (For a network error the panel stays open on purpose,
        // because retrying with the same key is safe.)
        setAttempt(undefined);
        setAlternatives(error.alternatives);
        refreshTimes();
      }
    } finally {
      setPending(false);
    }
  };

  const cancel = async (appointmentId: string) => {
    setCancelling(appointmentId);
    setNotice(undefined);
    try {
      const updated = await api.cancel(appointmentId);
      setBookings((list) => list.map((b) => (b.id === updated.id ? updated : b)));
      refreshTimes();
    } catch (error) {
      setNotice({ kind: 'error', error });
    } finally {
      setCancelling(null);
    }
  };

  const chooseCustomer = (id: string) => {
    setCustomerId(id);
    setVehicleId(customers.find((c) => c.id === id)?.vehicles[0]?.id ?? '');
  };

  return (
    <main className="page">
      <h1>Service booking</h1>
      <p className="hint">
        Demo front end for the Service Scheduler API. Customers and vehicles are SAMPLE data.
      </p>

      {referenceError !== undefined && (
        <div>
          <ErrorNotice error={referenceError} />
          <button type="button" onClick={() => setReferenceTick((t) => t + 1)}>
            Try again
          </button>
        </div>
      )}
      {referenceError === undefined && !reference && <p role="status">Loading…</p>}

      {reference && dealership && service && (
        <>
          <section aria-labelledby="find-heading">
            <h2 id="find-heading">Find a time</h2>
            <div className="filters">
              <div className="field">
                <label htmlFor="dealership">Dealership</label>
                <select
                  id="dealership"
                  value={dealershipId}
                  onChange={(e) => {
                    setDealershipId(e.target.value);
                    setAttempt(undefined);
                  }}
                >
                  {reference.dealerships.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="service">Service</label>
                <select
                  id="service"
                  value={serviceTypeId}
                  onChange={(e) => {
                    setServiceTypeId(e.target.value);
                    setAttempt(undefined);
                  }}
                >
                  {reference.serviceTypes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="date">Date</label>
                <input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setAttempt(undefined);
                  }}
                />
              </div>
            </div>
          </section>

          <section aria-labelledby="times-heading">
            <h2 id="times-heading">Available times</h2>
            <p className="hint">
              Times are shown in {dealership.timeZone} time, the dealership&apos;s clock.
            </p>
            <div role="status" aria-label="Available times" aria-live="polite">
              {availability.status === 'loading' && <p>Loading times…</p>}
              {availability.status === 'refreshing' && <p>Updating times…</p>}
              {availability.status === 'ready' && availability.slots.length === 0 && (
                <p>No times available on this date.</p>
              )}
              {availability.status === 'ready' && availability.slots.length > 0 && (
                <p>
                  {availability.slots.length} {availability.slots.length === 1 ? 'time' : 'times'}{' '}
                  available
                </p>
              )}
            </div>
            {(availability.status === 'ready' || availability.status === 'refreshing') && (
              <SlotList
                slots={availability.slots}
                timeZone={dealership.timeZone}
                disabled={pending}
                onChoose={openAttempt}
              />
            )}
            {availability.status === 'error' && (
              <div>
                <ErrorNotice error={availability.error} />
                <button type="button" onClick={refreshTimes}>
                  Try again
                </button>
              </div>
            )}
          </section>

          {attempt && (
            <ConfirmPanel
              slot={attempt.slot}
              dealership={dealership}
              service={service}
              customers={customers}
              customerId={customerId}
              vehicleId={vehicleId}
              pending={pending}
              onCustomer={chooseCustomer}
              onVehicle={setVehicleId}
              onBook={book}
              onBack={() => {
                setAttempt(undefined);
                setNotice(undefined);
                setAlternatives(undefined);
              }}
            />
          )}

          {notice?.kind === 'error' && <ErrorNotice error={notice.error} />}
          {notice?.kind === 'result' && (
            <p role="status" aria-label="Booking result" className="notice notice-ok">
              {notice.text}
            </p>
          )}
          {alternatives && (
            <Alternatives
              slots={alternatives}
              timeZone={dealership.timeZone}
              onChoose={openAttempt}
            />
          )}

          <SessionBookings
            bookings={bookings}
            dealerships={reference.dealerships}
            serviceTypes={reference.serviceTypes}
            cancelling={cancelling}
            onCancel={cancel}
          />
        </>
      )}
    </main>
  );
}
