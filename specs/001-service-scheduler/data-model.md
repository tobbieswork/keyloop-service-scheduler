# Data Model: Unified Service Scheduler

PostgreSQL 16 with `btree_gist`. All instants are `timestamptz`. IDs are UUIDs unless noted. Sample/seed rows are clearly marked as sample data.

## Entities

| Table | Key columns | Notes |
|---|---|---|
| `dealership` | `id`, `name`, `time_zone` (IANA) | One time zone per dealership |
| `dealership_hours` | `dealership_id`, `weekday` (0-6), `open_time`, `close_time` (local) | No row for a closed day. Unique on (`dealership_id`, `weekday`) |
| `skill` | `id`, `name` | e.g. brakes, electrical |
| `service_type` | `id`, `name`, `duration_minutes`, `buffer_minutes` (default 0), `required_skill_id` | Occupied time = duration + buffer |
| `service_bay` | `id`, `dealership_id`, `name` | Belongs to one dealership |
| `technician` | `id`, `dealership_id`, `name` | Belongs to one dealership |
| `technician_skill` | `technician_id`, `skill_id` | Many-to-many; primary key on both |
| `customer` | `id`, `name`, `contact` | Personal data. Never logged |
| `vehicle` | `id`, `customer_id`, `vin` (unique), `make`, `model` | Belongs to one customer |
| `bay_unavailability` | `id`, `bay_id`, `period` (`tstzrange`), `reason` | FR-015 |
| `technician_unavailability` | `id`, `technician_id`, `period` (`tstzrange`), `reason` | FR-015 |
| `appointment` | see below | The booking record (FR-006) |

### `appointment`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `customer_id`, `vehicle_id`, `service_type_id`, `dealership_id`, `bay_id`, `technician_id` | uuid FK, not null | Links customer, vehicle, technician and bay (FR-006) |
| `occupied_period` | `tstzrange` `[)` | Start to start + duration + buffer |
| `service_end` | timestamptz | Start + duration (without buffer), for display |
| `status` | enum `confirmed` / `cancelled` | Default `confirmed` |
| `idempotency_key` | text, unique, not null | FR-016 |
| `request_hash` | text, not null | Detects same key with a different body |
| `created_at`, `cancelled_at` | timestamptz | `cancelled_at` null unless cancelled |

## Constraints (the invariants)

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A bay never hosts two confirmed appointments at once (FR-007)
ALTER TABLE appointment ADD CONSTRAINT appointment_no_bay_overlap
  EXCLUDE USING gist (bay_id WITH =, occupied_period WITH &&)
  WHERE (status = 'confirmed');

-- A technician never works two confirmed appointments at once (FR-007)
ALTER TABLE appointment ADD CONSTRAINT appointment_no_technician_overlap
  EXCLUDE USING gist (technician_id WITH =, occupied_period WITH &&)
  WHERE (status = 'confirmed');

-- No empty or inverted periods
ALTER TABLE appointment ADD CONSTRAINT appointment_period_valid
  CHECK (NOT isempty(occupied_period) AND lower_inc(occupied_period) AND NOT upper_inc(occupied_period));
```

- `occupied_period` is half-open, so an appointment ending at 10:00 and one starting at 10:00 do not overlap (FR-005).
- Cancelled rows are excluded by the `WHERE` clause, so cancelling frees the resource and keeps the record (FR-013).
- Each unavailability table gets its own `EXCLUDE` on (resource, period) (`bay_unavailability_no_overlap`, `technician_unavailability_no_overlap`) so the same resource cannot have overlapping blocks, plus the same non-empty, half-open `CHECK` as appointments (`*_period_valid`).
- Reference-data rules enforced by the database: `service_type_duration_positive` (duration > 0), `service_type_buffer_not_negative` (buffer >= 0), `dealership_hours_weekday_valid` (weekday 0-6, where 0 = Sunday, matching Postgres `EXTRACT(dow)`), `dealership_hours_close_after_open`, one hours row per dealership and weekday (primary key), unique VIN (`vehicle_vin_key`), unique idempotency key (`appointment_idempotency_key_key`), and foreign keys on every reference.
- `status` is the Postgres enum `appointment_status`.
- Application checks: bay and technician must belong to the appointment's dealership; the technician must hold the service type's required skill; the vehicle must belong to the customer. Foreign keys cover existence.
- Unavailability vs appointments is checked inside the booking transaction under a row lock on the chosen bay and technician (research.md, decision 2).

## Indexes
- GiST indexes come from the exclusion constraints.
- `appointment (dealership_id, lower(occupied_period))` for the daily availability and least-booked queries.
- `appointment (idempotency_key)` is covered by its unique constraint.

## State transitions

```text
(request) --booking OK--> confirmed --cancel--> cancelled
(request) --conflict or invalid--> nothing stored
```

- `cancelled` is terminal in v1; cancelling twice returns the same cancelled record (idempotent).
- Reschedule = cancel plus a new booking with a new idempotency key.

## Validation rules (from the spec)
- Start time must be in the future, on a 15-minute boundary in the dealership's local time (FR-011).
- The whole occupied period must fit inside one day's working hours (FR-011).
- Unknown dealership, vehicle, service type or customer returns 404; a vehicle not owned by the customer returns 422.
- Unavailability period end must be after start, and must not overlap a confirmed appointment of that resource (409).
