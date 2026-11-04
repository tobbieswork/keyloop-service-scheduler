# Feature Specification: Unified Service Scheduler

**Feature Branch**: `001-service-scheduler` (spec directory only; no git branch created)

**Created**: 2026-11-04

**Status**: Reviewed (AI-drafted from the Keyloop Scenario A brief; reviewed and accepted by the owner 2026-11-04)

**Input**: User description: "Build an Appointment Scheduler application to replace manual booking systems. A user requests a service appointment for a specific vehicle, service type and dealership at a desired time. Before confirming, check that both a service bay and a qualified technician are available for the entire service duration. On success, create a persistent appointment record linking customer, vehicle, technician and service bay."

## Clarifications

### Session 2026-11-04

- Q: Should the system choose the bay and technician automatically, or should the requester pick them? → A: System auto-assigns; requester supplies vehicle, service type, dealership and time only.
- Q: How should the cleanup buffer work? → A: Per service type, added to the service duration (may be 0). Blocked time = duration + buffer.
- Q: Can a bay or technician be unavailable for set periods, or are all available during opening hours? → A: Per-resource unavailability. Bays and technicians can each be marked unavailable for a time range (maintenance, shift end, leave).
- Q: How should duplicate or retried booking requests be handled? → A: Idempotency key. Each booking request carries a unique client key; the same key returns the original result and never creates a second appointment.
- Q: How should the system choose between several eligible technicians or bays? → A: Least-booked that day (fewest appointments on that date), ties broken by lowest ID, so results are deterministic.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Book a service appointment (Priority: P1)

A customer (or a service adviser acting for them) asks for an appointment for a vehicle, a service type and a dealership at a desired start time. If a service bay and a qualified technician are both free for the whole service duration, the appointment is confirmed and stored.

**Why this priority**: This is the core of the product. Without a correct, conflict-free booking there is nothing to replace manual booking with.

**Independent Test**: Submit a booking request against seeded data (one dealership, one bay, one qualified technician). It is confirmed and a record is returned containing customer, vehicle, technician and bay.

**Acceptance Scenarios**:

1. **Given** a free bay and a free qualified technician for the full duration, **When** a booking is requested, **Then** the appointment is confirmed and a persistent record links customer, vehicle, technician and bay.
2. **Given** all bays are occupied for any part of the requested period, **When** a booking is requested, **Then** it is rejected with a clear conflict reason and nothing is stored.
3. **Given** no technician with the required skill is free for the full duration, **When** a booking is requested, **Then** it is rejected with a clear conflict reason and nothing is stored.
4. **Given** an existing appointment ends exactly when the new one starts, **When** the new booking is requested, **Then** it is accepted (back-to-back is not an overlap).

---

### User Story 2 - Check availability before booking (Priority: P2)

A user checks which start times are available for a service type at a dealership on a given day, before committing to a booking.

**Why this priority**: It turns a trial-and-error rejection into guided choice, and the same logic powers the "alternative slots" returned on a conflict.

**Independent Test**: Query availability for a service type and date. The result lists only start times where both a bay and a qualified technician are free for the full duration.

**Acceptance Scenarios**:

1. **Given** some bookings already exist, **When** availability is requested for a date, **Then** only fully bookable start times are returned.
2. **Given** a day with no capacity, **When** availability is requested, **Then** an empty result is returned, not an error.

---

### User Story 3 - Stay correct under simultaneous requests (Priority: P1)

Two users try to book the last available slot at the same moment. Exactly one succeeds; the other is told the slot was taken and is offered alternatives.

**Why this priority**: Double-booking a bay or technician is the failure that makes a scheduler worthless. Real-time availability checks alone cannot guarantee this.

**Independent Test**: Fire many parallel requests for the same last slot. Exactly one appointment exists afterwards.

**Acceptance Scenarios**:

1. **Given** one slot left, **When** N requests for it arrive concurrently, **Then** exactly one is confirmed and the rest receive a conflict response.
2. **Given** a conflict response, **When** it is returned, **Then** it includes alternative available slots.

---

### User Story 4 - View and cancel appointments (Priority: P3)

A user retrieves an appointment and can cancel it, which frees the bay and technician for others.

**Why this priority**: Useful and low-risk, but not required by the brief's three core requirements.

**Independent Test**: Cancel a confirmed appointment, then book the same slot again successfully.

**Acceptance Scenarios**:

1. **Given** a confirmed appointment, **When** it is cancelled, **Then** its bay and technician become available for that period.
2. **Given** a cancelled appointment, **When** it is retrieved, **Then** it is shown as cancelled and is preserved for audit.

---

### User Story 5 - Block a bay or technician (Priority: P2)

A service manager marks a bay (for example, under maintenance) or a technician (for example, on leave or off shift) as unavailable for a time range (an unavailability period, also called a block). The system then never assigns that resource during that time.

**Why this priority**: Without it, the scheduler books work onto bays that are out of service and technicians who are not there, which breaks trust quickly. It is not one of the brief's three core requirements, so it ranks below booking and concurrency safety.

**Independent Test**: Block the only qualified technician for a period, then request a booking in that period. It is rejected, and availability for that day no longer shows the blocked times.

**Acceptance Scenarios**:

1. **Given** a bay is blocked for a period, **When** a booking overlapping that period is requested, **Then** the blocked bay is not assigned (another bay is used, or the request is rejected if none is free).
2. **Given** a technician is blocked for a period, **When** availability is requested for that day, **Then** start times that need that technician during the blocked period are not offered unless another qualified technician is free.
3. **Given** a resource already has a confirmed appointment in a period, **When** someone tries to block that resource over that period, **Then** the block is rejected with a conflict and the appointment is untouched.
4. **Given** a booking and a block for the same resource and time arrive at the same moment, **When** both are processed, **Then** the stored result never has the appointment and the block overlapping.

---

### Edge Cases

- Request outside dealership working hours, or running past closing time.
- Start time in the past.
- Appointment that spans the end of one working day into the next.
- Unknown vehicle, service type or dealership.
- A technician qualified for the service at a different dealership only.
- Same idempotency key re-sent after a timeout (must return the original result); same key re-sent with different details (must be rejected).
- Service duration plus buffer exactly fills a gap between two appointments.
- A bay that is out of service or a technician who is off shift.
- Times given in different time zones than the dealership's.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept a booking request containing customer, vehicle, service type, dealership and desired start time.
- **FR-002**: System MUST determine the appointment's full occupied period as the service type's duration plus that service type's own buffer (which may be zero).
- **FR-003**: System MUST automatically assign a free service bay at that dealership, and MUST confirm a booking only if one is free for the entire period. The requester does not choose the bay.
- **FR-004**: System MUST automatically assign a technician qualified for that service type, and MUST confirm a booking only if one is free for the entire period. The requester does not choose the technician.
- **FR-005**: System MUST treat back-to-back appointments (end equals next start) as non-overlapping.
- **FR-006**: System MUST persist each confirmed appointment, linking customer, vehicle, technician and service bay.
- **FR-007**: System MUST guarantee a bay or technician is never double-booked, including under concurrent requests.
- **FR-008**: System MUST reject requests that cannot be fulfilled for lack of capacity with a clear conflict reason and MUST NOT store a partial appointment.
- **FR-009**: System MUST offer up to 5 alternative available slots when a request is rejected for lack of capacity, searching the requested day first and then the next 7 days, in time order.
- **FR-010**: System MUST allow querying available start times for a service type, dealership and date.
- **FR-011**: System MUST reject requests outside dealership working hours or in the past.
- **FR-012**: System MUST validate all input and return consistent, machine-readable errors.
- **FR-013**: System MUST allow retrieving and cancelling an appointment, retaining cancelled records.
- **FR-014**: System MUST log each booking outcome with a request identifier, without logging sensitive personal data.
- **FR-015**: System MUST allow a bay or technician to be marked unavailable for a time range, and MUST NOT assign that resource to any appointment whose occupied period overlaps it.
- **FR-016**: System MUST require a unique idempotency key on each booking request; repeating a key MUST return the original result and MUST NOT create another appointment.
- **FR-017**: When several bays or technicians are eligible, System MUST choose the one with the fewest appointments on the requested date, breaking ties by lowest ID.

### Key Entities

- **Dealership**: A location with working hours and a time zone; owns bays and employs technicians.
- **Service Bay**: A physical workspace at one dealership; hosts one appointment at a time.
- **Technician**: Works at one dealership, holds one or more skills, works one appointment at a time.
- **Skill**: A capability a technician holds that a service type may require.
- **Service Type**: A kind of service with a duration, a buffer and a required skill.
- **Vehicle**: Identified by VIN; belongs to a customer.
- **Customer**: The person the appointment is for.
- **Unavailability Period**: A time range during which one specific bay or technician cannot be assigned (maintenance, off shift, leave), with a reason.
- **Appointment**: Confirmed booking linking customer, vehicle, service type, dealership, technician, bay, start and end time, and a status (confirmed or cancelled).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero double-booked bays or technicians, verified by a concurrency test with many simultaneous requests for the same slot.
- **SC-002**: A booking request receives a confirmed or rejected answer in under 1 second under normal load.
- **SC-003**: Every booking rejected for lack of capacity includes a reason and, if any slot exists on the requested day or the next 7 days, at least one alternative (up to 5).
- **SC-004**: Every confirmed appointment can be retrieved afterwards with customer, vehicle, technician and bay.
- **SC-005**: Every acceptance scenario above is covered by an automated test.
- **SC-006**: Zero appointments overlap an unavailability period of their assigned bay or technician, including when booking and blocking happen concurrently.

## Assumptions

These fill gaps in the brief. All are open to change at the clarify step.

- A technician qualifies for a service type by holding its required skill.
- Technicians and bays are tied to one dealership; cross-dealership assignment is out of scope.
- Each dealership has fixed weekly working hours and one time zone. Dealership holidays are out of scope for v1; individual bay and technician unavailability is in scope (FR-015).
- Slots start on 15-minute boundaries.
- Authentication, payments, notifications and customer self-registration are out of scope; customers and vehicles are pre-seeded sample data, clearly marked as sample.
- One appointment per bay and per technician at a time; no overlapping work.
- Reschedule is modelled as cancel plus rebook (not a separate feature).
- Backend API is the implementation target; a thin UI may follow.
