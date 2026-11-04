import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { App } from './App';
import {
  ApiError,
  NetworkError,
  type ApiClient,
  type Appointment,
  type Dealership,
  type ServiceType,
  type Slot,
} from './api';

// ---------- fixtures ----------
const london: Dealership = { id: 'd-london', name: 'London', timeZone: 'Europe/London' };
const newYork: Dealership = { id: 'd-ny', name: 'New York', timeZone: 'America/New_York' };
const brakes: ServiceType = {
  id: 's-brakes',
  name: 'Brake service',
  durationMinutes: 90,
  bufferMinutes: 15,
};
const oil: ServiceType = {
  id: 's-oil',
  name: 'Oil change',
  durationMinutes: 30,
  bufferMinutes: 10,
};

// "Now" is Monday 2030-03-04 09:00 UTC, so the default date is Tuesday 2030-03-05.
const NOW = new Date('2030-03-04T09:00:00.000Z');
const slot = (hhmm: string, day = '2030-03-05'): Slot => ({
  startTime: `${day}T${hhmm}:00.000Z`,
  endTime: `${day}T${hhmm}:00.000Z`,
});
const appointment = (over: Partial<Appointment> = {}): Appointment => ({
  id: 'appt-1',
  customerId: 'c-a',
  vehicleId: 'v-a1',
  serviceTypeId: brakes.id,
  dealershipId: london.id,
  bayId: 'bay-1',
  technicianId: 'tech-1',
  startTime: '2030-03-05T09:00:00.000Z',
  serviceEndTime: '2030-03-05T10:30:00.000Z',
  occupiedUntil: '2030-03-05T10:45:00.000Z',
  status: 'confirmed',
  cancelledAt: null,
  ...over,
});

const demoCustomers = [
  {
    id: 'c-a',
    name: 'SAMPLE Customer A',
    vehicles: [
      { id: 'v-a1', label: 'SAMPLE Hatchback' },
      { id: 'v-a2', label: 'SAMPLE Estate' },
    ],
  },
  { id: 'c-b', name: 'SAMPLE Customer B', vehicles: [{ id: 'v-b1', label: 'SAMPLE SUV' }] },
];

type MockedApi = { [K in keyof ApiClient]: Mock<ApiClient[K]> };

function fakeApi(over: Partial<ApiClient> = {}): MockedApi {
  const api: ApiClient = {
    dealerships: vi.fn(async () => [london, newYork]),
    serviceTypes: vi.fn(async () => [brakes, oil]),
    availability: vi.fn(async () => [slot('08:00'), slot('09:00'), slot('10:15')]),
    book: vi.fn(async () => ({ appointment: appointment(), replayed: false })),
    cancel: vi.fn(async () =>
      appointment({ status: 'cancelled', cancelledAt: '2030-03-04T09:05:00.000Z' }),
    ),
    ...over,
  };
  return api as MockedApi;
}

let keyCounter = 0;
function mount(api: ApiClient) {
  keyCounter = 0;
  const user = userEvent.setup();
  render(
    <App
      api={api}
      now={() => NOW}
      newKey={() => `key-${++keyCounter}-aaaa`}
      customers={demoCustomers}
    />,
  );
  return { user };
}

/** Wait until the initial reference data and first availability are on screen. */
const ready = async () => screen.findByRole('button', { name: '08:00 GMT' });
const timeButton = (name: string) => screen.getByRole('button', { name });

// ---------- tests ----------
describe('loading and defaults (US1)', () => {
  it('shows a loading state, then the first dealership, first service and tomorrow in the dealership zone', async () => {
    mount(fakeApi());
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    await ready();
    expect(screen.getByLabelText('Dealership')).toHaveValue(london.id);
    expect(screen.getByLabelText('Service')).toHaveValue(brakes.id);
    expect(screen.getByLabelText('Date')).toHaveValue('2030-03-05');
  });

  it('asks for availability with those defaults', async () => {
    const api = fakeApi();
    mount(api);
    await ready();
    expect(api.availability).toHaveBeenCalledWith(
      { dealershipId: london.id, serviceTypeId: brakes.id, date: '2030-03-05' },
      expect.anything(),
    );
  });

  it('lists the times in the dealership zone, with the zone shown, and says how many', async () => {
    mount(fakeApi());
    await ready();
    expect(timeButton('09:00 GMT')).toBeInTheDocument();
    expect(timeButton('10:15 GMT')).toBeInTheDocument();
    expect(screen.getByText(/3 times available/i)).toBeInTheDocument();
    expect(screen.getByText(/Europe\/London/)).toBeInTheDocument();
  });

  it('shows "no times" as a normal state, not an error', async () => {
    mount(fakeApi({ availability: vi.fn(async () => []) }));
    expect(await screen.findByText(/no times available on this date/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('choosing a dealership, service or date', () => {
  it('reloads the times, and uses the NEW dealership time zone for display and for the default date', async () => {
    const api = fakeApi();
    const { user } = mount(api);
    await ready();

    await user.selectOptions(screen.getByLabelText('Dealership'), newYork.id);

    await waitFor(() =>
      expect(api.availability).toHaveBeenLastCalledWith(
        { dealershipId: newYork.id, serviceTypeId: brakes.id, date: '2030-03-05' },
        expect.anything(),
      ),
    );
    // 09:00 UTC is 04:00 in New York (EST, UTC-5), shown with its offset.
    expect(await screen.findByRole('button', { name: '04:00 GMT-5' })).toBeInTheDocument();
    expect(screen.getByText(/America\/New_York/)).toBeInTheDocument();
  });

  it('reloads when the service or the date changes', async () => {
    const api = fakeApi();
    const { user } = mount(api);
    await ready();
    await user.selectOptions(screen.getByLabelText('Service'), oil.id);
    await waitFor(() =>
      expect(api.availability).toHaveBeenLastCalledWith(
        expect.objectContaining({ serviceTypeId: oil.id }),
        expect.anything(),
      ),
    );
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-03-08' } });
    await waitFor(() =>
      expect(api.availability).toHaveBeenLastCalledWith(
        expect.objectContaining({ date: '2030-03-08' }),
        expect.anything(),
      ),
    );
  });

  it('never lets a slow earlier answer overwrite a newer one', async () => {
    let releaseSlow!: (slots: Slot[]) => void;
    const slow = new Promise<Slot[]>((r) => (releaseSlow = r));
    const availability = vi
      .fn<ApiClient['availability']>()
      .mockResolvedValueOnce([slot('08:00')]) // initial load
      .mockImplementationOnce(() => slow) // first change: slow
      .mockResolvedValueOnce([slot('13:00')]); // second change: fast
    const { user } = mount(fakeApi({ availability }));
    await ready();

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-03-06' } }); // slow one
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-03-07' } }); // fast one
    expect(await screen.findByRole('button', { name: '13:00 GMT' })).toBeInTheDocument();

    await act(async () => releaseSlow([slot('09:30')])); // the stale answer arrives last
    expect(screen.queryByRole('button', { name: '09:30 GMT' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '13:00 GMT' })).toBeInTheDocument();
    void user;
  });

  it('keeps the current times on screen while they refresh, and says they are updating', async () => {
    let release!: (slots: Slot[]) => void;
    const availability = vi
      .fn<ApiClient['availability']>()
      .mockResolvedValueOnce([slot('08:00'), slot('09:00')])
      .mockResolvedValueOnce([slot('08:00'), slot('09:00')]) // refresh after the booking...
      .mockImplementationOnce(() => new Promise<Slot[]>((r) => (release = r))); // ...held back
    const { user } = mount(fakeApi({ availability }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await screen.findByRole('status', { name: /booking result/i });
    await waitFor(() => expect(availability).toHaveBeenCalledTimes(2));

    // Cancelling triggers another refresh; hold it open and check nothing disappears meanwhile.
    await user.click(screen.getByRole('button', { name: /cancel booking/i }));
    await waitFor(() => expect(availability).toHaveBeenCalledTimes(3));
    expect(timeButton('08:00 GMT')).toBeInTheDocument();
    expect(screen.getByText(/updating times/i)).toBeInTheDocument();

    await act(async () => release([slot('08:00')]));
    await waitFor(() => expect(screen.queryByText(/updating times/i)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '09:00 GMT' })).not.toBeInTheDocument();
  });

  it('does NOT keep the old times when the user changes the date (they would be for the wrong day)', async () => {
    const availability = vi
      .fn<ApiClient['availability']>()
      .mockResolvedValueOnce([slot('08:00')])
      .mockImplementationOnce(() => new Promise<Slot[]>(() => {})); // never answers
    mount(fakeApi({ availability }));
    await ready();
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-03-08' } });
    expect(await screen.findByText(/loading times/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '08:00 GMT' })).not.toBeInTheDocument();
  });

  it('shows an error with a retry when the times cannot be loaded', async () => {
    const availability = vi
      .fn<ApiClient['availability']>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValue([slot('08:00')]);
    const { user } = mount(fakeApi({ availability }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the booking service/i);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: '08:00 GMT' })).toBeInTheDocument();
  });
});

describe('booking (US1)', () => {
  it('opens a confirmation for the chosen time with demo customer and vehicle pickers', async () => {
    const { user } = mount(fakeApi());
    await ready();
    await user.click(timeButton('09:00 GMT'));

    const panel = screen.getByRole('region', { name: /confirm booking/i });
    expect(within(panel).getByText(/Brake service/)).toBeInTheDocument();
    expect(within(panel).getByText(/Tue 5 Mar, 09:00 GMT/)).toBeInTheDocument();
    expect(within(panel).getByLabelText(/Customer/)).toHaveValue('c-a');
    expect(within(panel).getByLabelText(/Vehicle/)).toHaveValue('v-a1');
    expect(within(panel).getByText(/sample data/i)).toBeInTheDocument();
  });

  it("offers only the chosen customer's vehicles", async () => {
    const { user } = mount(fakeApi());
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.selectOptions(screen.getByLabelText(/Customer/), 'c-b');
    const vehicle = screen.getByLabelText(/Vehicle/);
    expect(vehicle).toHaveValue('v-b1');
    expect(within(vehicle).getAllByRole('option')).toHaveLength(1);
  });

  it('books the chosen instant with the chosen ids and an idempotency key, then confirms and lists it', async () => {
    const api = fakeApi();
    const { user } = mount(api);
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));

    await waitFor(() => expect(api.book).toHaveBeenCalledTimes(1));
    expect(api.book).toHaveBeenCalledWith(
      {
        customerId: 'c-a',
        vehicleId: 'v-a1',
        serviceTypeId: brakes.id,
        dealershipId: london.id,
        startTime: '2030-03-05T09:00:00.000Z',
      },
      'key-1-aaaa',
    );
    expect(await screen.findByRole('status', { name: /booking result/i })).toHaveTextContent(
      /booked/i,
    );
    const list = screen.getByRole('list', { name: /your bookings this session/i });
    expect(within(list).getByText(/Tue 5 Mar, 09:00 GMT/)).toBeInTheDocument();
    expect(within(list).getByText(/confirmed/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /confirm booking/i })).not.toBeInTheDocument();
  });

  it('refreshes the times after a booking', async () => {
    const api = fakeApi();
    const { user } = mount(api);
    await ready();
    const callsBefore = api.availability.mock.calls.length;
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await waitFor(() => expect(api.availability.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('disables the book button and says "Booking" while the request is in flight', async () => {
    let finish!: () => void;
    const book = vi.fn(
      () =>
        new Promise<{ appointment: Appointment; replayed: boolean }>(
          (r) => (finish = () => r({ appointment: appointment(), replayed: false })),
        ),
    );
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    expect(await screen.findByRole('button', { name: /booking/i })).toBeDisabled();
    await act(async () => finish());
    await screen.findByRole('status', { name: /booking result/i });
  });

  it('lets the user go back to choose a different time', async () => {
    const { user } = mount(fakeApi());
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /choose a different time/i }));
    expect(screen.queryByRole('region', { name: /confirm booking/i })).not.toBeInTheDocument();
  });

  it('says so when the API recognised a repeated request', async () => {
    const { user } = mount(
      fakeApi({ book: vi.fn(async () => ({ appointment: appointment(), replayed: true })) }),
    );
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    expect(await screen.findByRole('status', { name: /booking result/i })).toHaveTextContent(
      /already booked/i,
    );
  });
});

describe('retrying safely after a network failure (US1)', () => {
  it('reuses the SAME idempotency key, so a booking can never be created twice', async () => {
    const book = vi
      .fn<ApiClient['book']>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce({ appointment: appointment(), replayed: false });
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));

    await user.click(screen.getByRole('button', { name: /book this time/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the booking service/i);
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await screen.findByRole('status', { name: /booking result/i });

    expect(book).toHaveBeenCalledTimes(2);
    expect(book.mock.calls[0]![1]).toBe(book.mock.calls[1]![1]);
    expect(
      screen.getAllByRole('listitem').filter((li) => /Tue 5 Mar, 09:00/.test(li.textContent ?? '')),
    ).toHaveLength(1);
  });

  it('uses a NEW key when the user picks a different time', async () => {
    const book = vi
      .fn<ApiClient['book']>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValue({ appointment: appointment(), replayed: false });
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /choose a different time/i }));
    await user.click(timeButton('10:15 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(2));
    expect(book.mock.calls[0]![1]).not.toBe(book.mock.calls[1]![1]);
  });
});

describe('recovering from a conflict (US2)', () => {
  const conflict = (alternatives: Slot[]) =>
    new ApiError(
      409,
      'SLOT_UNAVAILABLE',
      'No service bay and qualified technician are both free for the requested time',
      'req-409',
      undefined,
      alternatives,
    );

  it("says the time was taken and offers the alternatives in the dealership's local date and time", async () => {
    const book = vi
      .fn<ApiClient['book']>()
      .mockRejectedValue(conflict([slot('10:15'), slot('08:00', '2030-03-06')]));
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no service bay and qualified technician/i);
    expect(alert).toHaveTextContent(/reference: req-409/i);
    expect(screen.getByRole('button', { name: 'Tue 5 Mar, 10:15 GMT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wed 6 Mar, 08:00 GMT' })).toBeInTheDocument();
  });

  it('closes the confirmation: that time is gone, so booking it again could only fail', async () => {
    const book = vi.fn<ApiClient['book']>().mockRejectedValue(conflict([slot('10:15')]));
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: /confirm booking/i })).not.toBeInTheDocument();
  });

  it('books an alternative with its own new key', async () => {
    const book = vi
      .fn<ApiClient['book']>()
      .mockRejectedValueOnce(conflict([slot('10:15')]))
      .mockResolvedValueOnce({
        appointment: appointment({ startTime: '2030-03-05T10:15:00.000Z' }),
        replayed: false,
      });
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await user.click(await screen.findByRole('button', { name: 'Tue 5 Mar, 10:15 GMT' }));
    await user.click(screen.getByRole('button', { name: /book this time/i }));

    await screen.findByRole('status', { name: /booking result/i });
    expect(book.mock.calls[1]![0].startTime).toBe('2030-03-05T10:15:00.000Z');
    expect(book.mock.calls[1]![1]).not.toBe(book.mock.calls[0]![1]);
  });

  it('explains when there are no alternatives either', async () => {
    const book = vi.fn<ApiClient['book']>().mockRejectedValue(conflict([]));
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    expect(await screen.findByText(/nothing else is free in the next days/i)).toBeInTheDocument();
  });
});

describe("cancelling this session's bookings (US3)", () => {
  async function bookOne(api: ReturnType<typeof fakeApi>) {
    const { user } = mount(api);
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await screen.findByRole('status', { name: /booking result/i });
    return { user };
  }

  it('cancels, marks the booking cancelled, removes its button, and refreshes the times', async () => {
    const api = fakeApi();
    const { user } = await bookOne(api);
    const callsBefore = api.availability.mock.calls.length;

    await user.click(screen.getByRole('button', { name: /cancel booking tue 5 mar, 09:00 gmt/i }));

    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('appt-1'));
    const list = screen.getByRole('list', { name: /your bookings this session/i });
    expect(await within(list).findByText(/cancelled/i)).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /cancel booking/i })).not.toBeInTheDocument();
    await waitFor(() => expect(api.availability.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('shows an error and keeps the booking confirmed if cancelling fails', async () => {
    const cancel = vi.fn(async () => {
      throw new ApiError(404, 'NOT_FOUND', 'No appointment exists with that ID', 'req-c1');
    });
    const { user } = await bookOne(fakeApi({ cancel }));
    await user.click(screen.getByRole('button', { name: /cancel booking/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no appointment exists/i);
    expect(alert).toHaveTextContent(/req-c1/);
    expect(
      within(screen.getByRole('list', { name: /your bookings this session/i })).getByText(
        /confirmed/i,
      ),
    ).toBeInTheDocument();
  });

  it('starts with no bookings, and says the list only covers this session', async () => {
    mount(fakeApi());
    await ready();
    expect(screen.getByText(/no bookings yet/i)).toBeInTheDocument();
    expect(screen.getByText(/this session only/i)).toBeInTheDocument();
  });
});

describe('errors (US4)', () => {
  it('shows a business-rule error with its message and the request ID', async () => {
    const book = vi
      .fn<ApiClient['book']>()
      .mockRejectedValue(
        new ApiError(422, 'OUTSIDE_WORKING_HOURS', 'The dealership is closed that day', 'req-422'),
      );
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The dealership is closed that day');
    expect(alert).toHaveTextContent('Reference: req-422');
    expect(screen.queryByText(/nothing else is free/i)).not.toBeInTheDocument();
  });

  it('keeps the confirmation open after an error so the user can retry or choose another time', async () => {
    const book = vi
      .fn<ApiClient['book']>()
      .mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Internal server error', 'req-500'));
    const { user } = mount(fakeApi({ book }));
    await ready();
    await user.click(timeButton('09:00 GMT'));
    await user.click(screen.getByRole('button', { name: /book this time/i }));
    await screen.findByRole('alert');
    expect(screen.getByRole('region', { name: /confirm booking/i })).toBeInTheDocument();
  });

  it('shows a clear message and a retry when the reference data cannot be loaded', async () => {
    const dealerships = vi
      .fn<ApiClient['dealerships']>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValue([london]);
    const { user } = mount(fakeApi({ dealerships }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the booking service/i);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByLabelText('Dealership')).toBeInTheDocument();
  });
});

describe('accessibility basics (FR-007)', () => {
  it('labels every control, and announces results in live regions', async () => {
    mount(fakeApi());
    await ready();
    for (const label of ['Dealership', 'Service', 'Date'])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /available times/i })).toBeInTheDocument();
  });

  it('has one main landmark and a heading hierarchy that starts at level 1', async () => {
    mount(fakeApi());
    await ready();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
