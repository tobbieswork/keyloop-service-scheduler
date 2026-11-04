# Feature Specification: Booking UI

**Created**: 2026-11-04 | **Status**: Draft (AI-drafted, pending owner review) | **Depends on**: `001-service-scheduler`

**Input**: "A simple frontend" for the Unified Service Scheduler, talking to the real backend API.

The brief asks for ONE layer in depth; the backend is that layer. This UI is a deliberately small
second layer to show the API works end to end for a person. It is not a product: no accounts, no
customer search, no styling framework.

## User Scenarios & Testing

### User Story 1 - Find a time and book it (Priority: P1)
A service adviser chooses a dealership, a service type and a date, sees the times that can be
booked (in the **dealership's local time**), picks one, confirms, and sees the booking confirmed.

**Independent Test**: With the backend running on seeded data, choose London, a brake service and a
future weekday. Times appear; click one; confirm; a confirmation shows the appointment time.

**Acceptance Scenarios**
1. **Given** dealerships and service types are loaded, **When** all three choices are made, **Then** the bookable start times for that date are listed, in the dealership's time zone.
2. **Given** a list of times, **When** one is chosen and confirmed, **Then** the booking is sent with a fresh idempotency key and the confirmed appointment is shown.
3. **Given** a date with no bookable times (closed day, fully booked), **Then** a clear "no times available" message is shown, not an error.
4. **Given** the request is slow or fails because of the network, **When** the user retries, **Then** the SAME idempotency key is reused, so a booking is never created twice.

### User Story 2 - Recover from a conflict (Priority: P1)
When someone else took the time first, the UI says so and offers the alternative slots the API returned.

**Acceptance Scenarios**
1. **Given** a `409 SLOT_UNAVAILABLE` with alternatives, **Then** the message and the alternatives (in local time) are shown, and choosing one books it with a new key.
2. **Given** a `409` with no alternatives, **Then** the message says nothing is free in the next days.

### User Story 3 - See and cancel this session's bookings (Priority: P2)
Bookings made in this browser session are listed with their status, and each can be cancelled.

**Acceptance Scenarios**
1. **Given** a confirmed booking, **When** Cancel is pressed, **Then** the booking shows as cancelled and its time returns to the available list on refresh.
2. **Given** the page is reloaded, **Then** the list is empty (the API has no list endpoint; documented, not hidden).

### User Story 4 - Understand what went wrong (Priority: P2)
Every failure shows the API's message and the request ID, so it can be found in the logs.

**Acceptance Scenarios**
1. **Given** a `422` or `400`, **Then** the user-facing message is shown with the request ID.
2. **Given** the API is unreachable, **Then** a "cannot reach the service" message is shown with a retry.
3. **Given** data is loading, **Then** a loading state is visible and controls are disabled while a request is in flight.

## Requirements
- **FR-001**: Choose dealership, service type and date; defaults: first dealership, first service type, tomorrow in the dealership's time zone.
- **FR-002**: Show bookable times from `GET /availability`, formatted in the dealership's time zone with the zone abbreviation.
- **FR-003**: Book via `POST /appointments` with an `Idempotency-Key` that stays the same across retries of one attempt.
- **FR-004**: Show alternatives from a `409` and let the user book one.
- **FR-005**: List this session's bookings; cancel via `POST /appointments/{id}/cancel`.
- **FR-006**: Show API error message plus request ID; distinguish network failure from API errors.
- **FR-007**: Keyboard accessible, labelled controls, announce results to screen readers, usable at phone width.
- **FR-008**: Customer and vehicle come from a clearly labelled **demo picker** using the SAMPLE records from the seed data.

## Assumptions
- No authentication, so the UI cannot (and must not) list real customers; it offers the SAMPLE ones. This is a stated limitation of the demo, not of the API design.
- The browser talks to the API through a dev-server proxy (`/api`), so the backend needs no CORS change.
- Times are always displayed in the dealership's zone, never the browser's, because "09:00" must mean the same thing to everyone booking for that dealership.
- Out of scope: blocking bays or technicians, editing, searching, persistence across reloads, internationalisation, a design system.

## Success Criteria
- **SC-001**: A first-time user completes a booking in under 30 seconds on seeded data.
- **SC-002**: Every acceptance scenario above is covered by an automated test.
- **SC-003**: The same time shown in the UI and the same time booked in the API always agree, including across daylight-saving changes.
