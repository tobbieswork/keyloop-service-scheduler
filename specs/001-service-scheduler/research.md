# Research and Decisions: Unified Service Scheduler

All technical unknowns are resolved. The stack defaults were confirmed by the owner on 2026-11-04.

## 1. HTTP framework
- **Decision**: Fastify
- **Rationale**: Built-in schema validation and pino logging, strong TypeScript support, good OpenAPI tooling, lower overhead than Express.
- **Alternatives**: Express (more familiar, but validation, logging and OpenAPI are all add-ons); NestJS (too heavy for this scope).

## 2. Double-booking prevention (core decision)
- **Decision**: One transaction per booking. A Postgres exclusion constraint on `(resource_id =, occupied_period &&)` for bays and for technicians, over appointments with status `confirmed`. Time ranges are half-open `[start, end)` so back-to-back appointments are allowed. A bounded retry (max 3) recomputes the choice when a constraint violation (`23P01`) occurs.
- **Rationale**: The database is the only place that can enforce the invariant under concurrency. An application-level check-then-insert races. The constraint is a hard backstop even if application code has a bug.
- **Alternatives**: App-level check only (races, rejected). Row locking only (works, but invariant lives in code, not schema). Serializable isolation alone (correct but retries cost more and the schema doesn't document the rule). Advisory locks per dealership (simple but serializes all bookings at a dealership).
- **Unavailability periods** cannot be covered by an appointment-only exclusion constraint. The booking transaction therefore (a) locks the chosen bay and technician rows `FOR UPDATE` in a fixed order (bay, then technician, by ID), (b) re-checks unavailability overlap inside the transaction. Creating an unavailability period takes the same row lock. This closes the booking-versus-unavailability race.
- **Deadlock avoidance**: fixed lock order; locks are held only for the short transaction.
- **Refinement made during implementation (2026-11-04), pending owner confirmation**: locks are taken with `FOR UPDATE SKIP LOCKED`, walking candidates in ranked order (fewest bookings that day, then lowest ID). A booking never waits for another booking's lock. Reasons:
  1. *No deadlocks at all*, since nothing ever waits on a lock.
  2. *No false "no capacity" answers under load.* With blocking locks every contender chases the same best candidate, so with 10 free bays the 4th contender would exhaust 3 retries and be told "full". With `SKIP LOCKED` contenders spread over free resources.
  3. The ranking rule stays in the pure domain layer (`rankByLeastBooked`), unit-tested, rather than being duplicated in SQL.
  The attempt is: read free candidates, lock the best unlocked bay and technician, **re-check under the locks** (the lists were read before them), insert. If every free candidate is momentarily held by another in-flight booking, or the database's exclusion constraint rejects the insert (`23P01`), the attempt is retried (max 3, short random pause) with the choice recomputed. The exclusion constraint is still the final safety net.
- **Known trade-off**: if all free resources stay locked by other in-flight bookings for all 3 attempts, the caller gets 409 although capacity may exist. This is rare, harmless (nothing is double-booked) and the response includes alternatives.

## 3. Time model
- **Decision**: Store all instants as `timestamptz` (UTC). Each dealership has an IANA time zone and weekly working hours in local time. The API accepts ISO 8601 timestamps with offset and validates 15-minute alignment and working hours in the dealership's local time.
- **Rationale**: Avoids daylight-saving bugs; the local-time rules live in one place (domain layer).
- **Alternatives**: Naive local timestamps (ambiguous at DST changes, rejected).
- **Rule**: The whole occupied period (duration + buffer) must fit within a single day's working hours.

## 4. Idempotency
- **Decision**: Required `Idempotency-Key` header. Stored on the appointment with a hash of the request body. Same key and same body returns the original appointment (HTTP 200, `Idempotent-Replayed: true`). Same key and different body returns 422 `IDEMPOTENCY_KEY_REUSED`. Concurrent same-key requests are resolved by a unique constraint, with the loser reading the winner's row.
- **Rationale**: Safe retries after timeouts without double-booking or confusing conflicts.
- **Known limit**: A request rejected with 409 stores nothing, so a retry with the same key is re-evaluated. This is intended, because capacity may have changed.
- **Replay after cancel**: replaying a key whose appointment has since been cancelled returns 200 with the current (cancelled) record. It never creates a new booking; rebooking needs a new key.
- **Alternatives**: Duplicate detection by content (breaks legitimate repeat bookings); no handling (weak reliability).

## 5. Resource selection
- **Decision**: Pick the bay and the technician with the fewest confirmed appointments on the requested dealership-local date, ties by lowest ID (FR-017). Chosen independently for bay and technician.
- **Rationale**: Deterministic (testable) and spreads work.
- **Alternatives**: Lowest ID (overloads one person); random (not testable).

## 6. Data access
- **Decision**: Kysely over `pg`, SQL migrations with raw DDL for the exclusion constraints and `btree_gist`.
- **Rationale**: Typed queries without hiding SQL; exclusion constraints and range operators need raw SQL in any ORM anyway.
- **Alternatives**: Prisma (no native exclusion-constraint support in the schema); TypeORM (heavier, weaker types); plain `pg` (no type safety).

## 7. Validation and contract
- **Decision**: Zod schemas drive request validation and the generated OpenAPI document. A hand-written `contracts/openapi.yaml` is the reviewed contract, and a contract test checks that responses match it.
- **Rationale**: One source of truth for validation, and the contract can't silently drift.

## 8. Error format
- **Decision**: One JSON shape: `{ "error": { "code", "message", "requestId", "details?" } }`. A capacity conflict adds a top-level `alternatives` array: up to 5 available slots, searching the requested day first and then the next 7 days, in time order, computed by the same availability logic (FR-009, SC-003). Empty only when nothing is free in that 8-day window.
- **Status mapping** (one table, used by the error handler and the tests):

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request is malformed: missing or invalid field or header (including `Idempotency-Key`), bad UUID or date format |
| `NOT_FOUND` | 404 | Referenced dealership, service type, customer, vehicle, appointment, bay or technician does not exist |
| `SLOT_UNAVAILABLE` | 409 | No bay or no qualified technician free for the whole period |
| `RESOURCE_HAS_APPOINTMENTS` | 409 | An unavailability period would overlap a confirmed appointment |
| `OUTSIDE_WORKING_HOURS` | 422 | Well-formed, but outside working hours, not on a 15-minute boundary, or not fitting in one day's working hours |
| `START_IN_PAST` | 422 | Well-formed, but the start time is in the past |
| `VEHICLE_CUSTOMER_MISMATCH` | 422 | Vehicle does not belong to the customer |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key sent with a different request body |
| `INTERNAL_ERROR` | 500 | Anything unexpected (details never leaked) |

  Rule of thumb: 400 = the request is malformed, 422 = the request is well-formed but breaks a business rule.

## 9. Testing
- **Decision**: Vitest. Unit tests for pure domain logic. Integration and concurrency tests run against a real Postgres via Testcontainers (Docker required; OrbStack is installed but its daemon must be running). Parallel booking test fires N requests for the last slot and asserts exactly one confirmed appointment.
- **Rationale**: Mocking the database would hide exactly the bugs this system exists to prevent.
- **Alternatives**: Docker Compose Postgres only (needs manual setup before tests); pg-mem (does not support exclusion constraints, rejected).

## 10. Observability
- **Logs**: pino, JSON, with a request ID (from `x-request-id` or generated) on every line. No customer names, emails or VINs in logs; IDs only.
- **Metrics** (`/metrics`, Prometheus format): booking outcomes by result (`confirmed`, `conflict`, `invalid`), constraint-violation retries, request duration histogram, availability query duration.
- **Tracing**: OpenTelemetry with HTTP and `pg` auto-instrumentation plus a manual span around the booking transaction and availability query. Console exporter by default; OTLP endpoint via environment variable.
- **Health**: `/health` (liveness) and `/ready` (database reachable).

## 11. Out of scope (v1)
Authentication and authorization, payments, notifications, dealership holidays, cross-dealership assignment, automatic cancellation when an unavailability period is added over existing appointments (the request is rejected with 409 instead), rate limiting. Each is a documented assumption, not an oversight.
