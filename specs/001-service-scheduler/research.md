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

## 3. Time model
- **Decision**: Store all instants as `timestamptz` (UTC). Each dealership has an IANA time zone and weekly opening hours in local time. The API accepts ISO 8601 timestamps with offset and validates 15-minute alignment and opening hours in the dealership's local time.
- **Rationale**: Avoids daylight-saving bugs; the local-time rules live in one place (domain layer).
- **Alternatives**: Naive local timestamps (ambiguous at DST changes, rejected).
- **Rule**: The whole occupied period (duration + buffer) must fit within a single day's opening hours.

## 4. Idempotency
- **Decision**: Required `Idempotency-Key` header. Stored on the appointment with a hash of the request body. Same key and same body returns the original appointment (HTTP 200, `Idempotent-Replayed: true`). Same key and different body returns 422 `IDEMPOTENCY_KEY_REUSED`. Concurrent same-key requests are resolved by a unique constraint, with the loser reading the winner's row.
- **Rationale**: Safe retries after timeouts without double-booking or confusing conflicts.
- **Known limit**: A request rejected with 409 stores nothing, so a retry with the same key is re-evaluated. This is intended, because capacity may have changed.
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
- **Decision**: One JSON shape: `{ "error": { "code", "message", "requestId", "details?" } }`. Conflicts return 409 with `alternatives` (up to 5 nearby available slots from the same availability logic).

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
