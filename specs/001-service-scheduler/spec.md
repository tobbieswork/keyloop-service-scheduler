# Feature Specification: Unified Service Scheduler

**Feature Branch**: `001-service-scheduler` (spec directory only; no git branch created)

**Created**: 2026-11-04

**Status**: Draft (AI-drafted from the Keyloop Scenario A brief; pending owner review)

**Input**: User description: "Build an Appointment Scheduler application to replace manual booking systems. A user requests a service appointment for a specific vehicle, service type and dealership at a desired time. Before confirming, check that both a service bay and a qualified technician are available for the entire service duration. On success, create a persistent appointment record linking customer, vehicle, technician and service bay."

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

### Edge Cases

- Request outside dealership working hours, or running past closing time.
- Start time in the past.
- Appointment that spans the end of one working day into the next.
- Unknown vehicle, service type or dealership.
- A technician qualified for the service at a different dealership only.
- Duplicate submission of the same request (retry by the client).
- Service duration plus buffer exactly fills a gap between two appointments.
- A bay that is out of service or a technician who is off shift.
- Times given in different time zones than the dealership's.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept a booking request containing customer, vehicle, service type, dealership and desired start time.
- **FR-002**: System MUST determine the appointment's full occupied period from the service type's duration plus any configured buffer.
- **FR-003**: System MUST confirm a booking only if a service bay at that dealership is free for the entire period.
- **FR-004**: System MUST confirm a booking only if a technician qualified for that service type is free for the entire period.
- **FR-005**: System MUST treat back-to-back appointments (end equals next start) as non-overlapping.
- **FR-006**: System MUST persist each confirmed appointment, linking customer, vehicle, technician and service bay.
- **FR-007**: System MUST guarantee a bay or technician is never double-booked, including under concurrent requests.
- **FR-008**: System MUST reject unavailable requests with a clear conflict reason and MUST NOT store a partial appointment.
- **FR-009**: System MUST offer alternative available slots when a request is rejected for lack of capacity.
- **FR-010**: System MUST allow querying available start times for a service type, dealership and date.
- **FR-011**: System MUST reject requests outside dealership working hours or in the past.
- **FR-012**: System MUST validate all input and return consistent, machine-readable errors.
- **FR-013**: System MUST allow retrieving and cancelling an appointment, retaining cancelled records.
- **FR-014**: System MUST log each booking outcome with a request identifier, without logging sensitive personal data.

### Key Entities

- **Dealership**: A location with working hours and a time zone; owns bays and employs technicians.
- **Service Bay**: A physical workspace at one dealership; hosts one appointment at a time.
- **Technician**: Works at one dealership, holds one or more skills, works one appointment at a time.
- **Skill**: A capability a technician holds that a service type may require.
- **Service Type**: A kind of service with a duration, a buffer and a required skill.
- **Vehicle**: Identified by VIN; belongs to a customer.
- **Customer**: The person the appointment is for.
- **Appointment**: Confirmed booking linking customer, vehicle, service type, dealership, technician, bay, start and end time, and a status (confirmed or cancelled).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero double-booked bays or technicians, verified by a concurrency test with many simultaneous requests for the same slot.
- **SC-002**: A booking request receives a confirmed or rejected answer in under 1 second under normal load.
- **SC-003**: Every rejected booking includes a reason and, where capacity exists elsewhere, at least one alternative slot.
- **SC-004**: Every confirmed appointment can be retrieved afterwards with customer, vehicle, technician and bay.
- **SC-005**: Every acceptance scenario above is covered by an automated test.

## Assumptions

These fill gaps in the brief. All are open to change at the clarify step.

- Duration includes a cleanup buffer that is configurable per service type.
- A technician qualifies for a service type by holding its required skill.
- Technicians and bays are tied to one dealership; cross-dealership assignment is out of scope.
- Each dealership has fixed weekly working hours and one time zone; holidays and shift rosters are out of scope for v1.
- Slots start on 15-minute boundaries.
- Authentication, payments, notifications and customer self-registration are out of scope; customers and vehicles are pre-seeded sample data, clearly marked as sample.
- One appointment per bay and per technician at a time; no overlapping work.
- Reschedule is modelled as cancel plus rebook (not a separate feature).
- Backend API is the implementation target; a thin UI may follow.
