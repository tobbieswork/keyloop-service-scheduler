# Booking UI

A small React front end for the Service Scheduler API. It is deliberately simple (no UI framework,
no state library): choose a dealership, a service and a date, see the bookable times in the
dealership's own clock, book one, recover from a conflict, and cancel.

Spec: [`specs/002-booking-ui/spec.md`](../specs/002-booking-ui/spec.md).

## Run it

The backend must be running (see the root README: `docker compose up -d db`, `npm run migrate`,
`npm run seed`, `npm run dev`). Then, in this folder:

```bash
npm install
npm run dev          # http://localhost:5173
```

The dev server forwards `/api/...` to the backend (default `http://localhost:3000`, override with
`BACKEND_URL`), so the browser sees one origin and the backend needs no CORS configuration.

```bash
npm test             # 61 tests: time formatting, API client, the whole UI against a fake backend
npm run typecheck
npm run build        # production bundle in dist/ (about 73 KB gzipped)
npm run preview      # serve the production build on http://localhost:4173, same proxy
```

## What it does

|                 |                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Find a time** | Dealership, service, date. Defaults: first dealership, first service, tomorrow **in the dealership's time zone**.                                                                                                                              |
| **Times**       | From `GET /availability`, shown in the dealership's zone with its offset (`09:00 GMT`, `08:00 GMT-4`), never the browser's. A newer request cancels an older one, so a slow answer cannot overwrite a fresh one.                               |
| **Book**        | Choose a time, confirm, `POST /appointments` with an `Idempotency-Key`. The key is created when you pick a time and **reused if you retry after a network failure**, so a booking can never be created twice. A different time gets a new key. |
| **Conflict**    | On a `409` the confirmation closes (that time is gone) and the API's alternative slots are offered.                                                                                                                                            |
| **Cancel**      | Bookings made in this session are listed with a Cancel button.                                                                                                                                                                                 |
| **Errors**      | The API's message plus its request ID (`Reference: ...`), so a failure can be found in the service logs. "Cannot reach the service" is shown differently from an API error, with a retry.                                                      |
| **Refresh**     | After a booking or cancel the list of times updates in place ("Updating times...") instead of disappearing.                                                                                                                                    |

## Honest limitations

- **Customers and vehicles are a demo picker** using the SAMPLE records from `npm run seed`. The API
  deliberately has no customer-listing endpoint (personal data, and no authentication yet), so a UI
  cannot look customers up. This is stated on screen.
- **The booking list is this session only.** The API has no endpoint that lists appointments, so a
  reload clears the list. This is stated on screen.
- No blocking of bays or technicians, no editing, no search, no authentication, English only.
- The automated tests use a fake backend. The UI was also run by hand in a real browser against the
  real backend, which found four problems the tests had missed (see the AI log); that browser session
  is not part of the automated suite.

## Layout

```text
src/time.ts         display in the dealership zone (daylight saving aware), default date
src/api.ts          typed client; ApiError (with request ID, alternatives) vs NetworkError
src/App.tsx         state: loading, availability, booking attempt, session bookings
src/components.tsx  presentational pieces
src/demoData.ts     the SAMPLE customers, clearly labelled as demo data
```
