# Tasks: Unified Service Scheduler

**Input**: `specs/001-service-scheduler/` (plan.md, spec.md, research.md, data-model.md, contracts/openapi.yaml, quickstart.md)

**Tests**: Required. The constitution mandates test-first and SC-005 requires every acceptance scenario to be covered. Write each test task, watch it fail, then implement.

**Format**: `- [ ] T### [P?] [Story?] Description with file path`. `[P]` means it touches different files and has no unfinished dependency, so it can run in parallel.

**Scope**: backend only. The thin frontend is a separate spec and cycle after this one.

**AI log**: after each checkpoint, add an `AI_LOG.md` entry (what the AI produced, what was wrong, what you decided, how it was verified).

## Phase 1: Setup

**Purpose**: Project skeleton and tooling

- [x] T001 Create the project skeleton per plan.md: `package.json` (scripts: dev, build, start, migrate, seed, test, test:concurrency, lint, typecheck), `tsconfig.json` (strict), `.nvmrc` (24), `src/` and `tests/` folders
- [x] T002 Install pinned dependencies in `package.json`: fastify, zod, fastify-type-provider-zod, @fastify/swagger, kysely, pg, pino, prom-client, @opentelemetry/sdk-node and instrumentations; dev: typescript, tsx, vitest, testcontainers, @testcontainers/postgresql, eslint, prettier, @redocly/cli
- [x] T003 [P] Configure ESLint and Prettier in `eslint.config.js` and `.prettierrc`
- [x] T004 [P] Add `docker-compose.yml` (Postgres 16 with healthcheck) and `.env.example` (no real secrets)
- [x] T005 [P] Configure Vitest in `vitest.config.ts` with separate `unit` and `integration` projects (integration timeout 60s)

---

## Phase 2: Foundational (blocks all user stories)

**Purpose**: Schema, shared domain primitives, API skeleton and observability. No user story can start before this is done.

- [x] T006 Write failing config tests in `tests/unit/config.test.ts` (missing or invalid env vars are rejected at startup)
- [x] T007 Implement `src/config.ts` with Zod-validated environment config
- [x] T008 Add Kysely instance, generated or hand-written table types and a migrate runner in `src/db/index.ts`, `src/db/types.ts`, `src/db/migrate.ts`
- [x] T009 Add Testcontainers helper `tests/integration/helpers/db.ts` (start Postgres, run migrations, truncate between tests)
- [x] T010 Remove `passWithNoTests` from `vitest.config.ts`, then write failing integration test `tests/integration/schema.constraints.test.ts` using Testcontainers: overlapping bay rejected, overlapping technician rejected, back-to-back allowed, cancelled frees the slot, duplicate idempotency key rejected, empty and inclusive-upper periods rejected (the 10 scenarios already verified by hand against `data-model.md`)
- [x] T011 Create migration `src/db/migrations/001_init.ts` with all tables, `btree_gist`, the two exclusion constraints, the period CHECK and the unavailability exclusion constraints exactly as in `data-model.md`
- [x] T012 Add SAMPLE seed data in `src/db/seed.ts`: 2 dealerships in different time zones with weekly hours, bays, technicians with skills, service types (some with buffer), customers and vehicles. Every record name is prefixed `SAMPLE`
- [x] T013 [P] Write failing unit tests `tests/unit/time-range.test.ts`: half-open overlap, back-to-back is not overlap, containment, empty range
- [x] T014 Implement `src/domain/time-range.ts`
- [x] T015 [P] Write failing unit tests `tests/unit/working-hours.test.ts`: dealership-local working hours, 15-minute alignment, whole occupied period inside one day's hours, DST change day, closed weekday
- [x] T016 Implement `src/domain/working-hours.ts`
- [x] T017 Add the error model in `src/api/errors.ts`: the single error JSON shape and the code-to-HTTP-status table in `research.md` (decision 8), plus the Fastify error handler (schema validation errors map to 400 `VALIDATION_ERROR`)
- [x] T018 Write failing test `tests/unit/observability.test.ts` (unit, no database needed): every log line carries the request ID, no log line contains a customer name or VIN, metrics labels stay bounded, spans record errors
- [x] T019 Add observability base in `src/observability/`: pino logger with request ID (`x-request-id` or generated) and PII-safe serializers, Prometheus registry, OpenTelemetry bootstrap (console exporter by default, OTLP via env)
- [x] T020 Build the Fastify app in `src/server.ts` and `src/api/app.ts` with `/health`, `/ready` (DB check), `/metrics`, Zod type provider and Swagger
- [x] T021 Add contract-test helper `tests/contract/helpers.ts` that validates a response against `contracts/openapi.yaml`

**Checkpoint**: migrations apply on a fresh Postgres, the constraint tests pass, the server starts and `/health` responds. Add the first `AI_LOG.md` implementation entry.

---

## Phase 3: User Story 1 - Book a service appointment (P1) MVP

**Purpose**: A booking is confirmed only when a bay and a qualified technician are free for the whole occupied period; otherwise nothing is stored.

- [x] T022 [US1] Write failing unit tests `tests/unit/occupied-period.test.ts`: duration plus buffer (including zero buffer) gives the right period
- [x] T023 [P] [US1] Write failing unit tests `tests/unit/resource-selection.test.ts`: fewest appointments on the dealership-local date wins, ties go to the lowest ID, a technician without the required skill is never chosen
- [x] T024 [P] [US1] Write failing integration tests `tests/integration/booking.test.ts`: happy path links customer, vehicle, technician and bay; no free bay gives 409; no qualified technician gives 409; skill mismatch; back-to-back accepted; outside hours; start in the past; unknown references give 404; vehicle not owned by the customer gives 422; a technician or bay belonging to a different dealership is never assigned; malformed input (bad UUID, bad date, missing `Idempotency-Key`, missing field) gives 400 `VALIDATION_ERROR`; `GET /appointments/{id}` returns the stored appointment with customer, vehicle, technician and bay; nothing is stored on failure
- [x] T025 [P] [US1] Write failing idempotency tests `tests/integration/idempotency.test.ts`: same key and body returns the original with `Idempotent-Replayed`; same key and different body gives 422; a 409 stores nothing so a retry is re-evaluated; replaying a key after the appointment was cancelled returns 200 with the cancelled record
- [x] T026 [P] [US1] Write failing contract test `tests/contract/appointments.contract.test.ts` for `POST /appointments` (201, 200 replay, 400, 404, 409, 422) and `GET /appointments/{id}` (200, 404)
- [x] T027 [US1] Implement `src/domain/occupied-period.ts` and `src/domain/resource-selection.ts`
- [x] T028 [US1] Implement repositories `src/db/repositories/appointments.ts`, `resources.ts`, `reference.ts`
- [x] T029 [US1] Implement `src/services/booking.ts`: one transaction, row locks on the chosen bay and technician in fixed order (bay then technician by ID), insert, idempotency handling via the unique key and request hash
- [x] T030 [US1] Implement `POST /appointments` and `GET /appointments/{id}` in `src/api/routes/appointments.ts` with Zod schemas, required `Idempotency-Key` header and error mapping
- [x] T031 [US1] Add booking metrics (outcome counter by result, duration histogram) and a trace span around the booking transaction in `src/services/booking.ts`
- [x] T032 [US1] Break-the-logic check: temporarily remove the overlap check and, separately, the exclusion constraint; confirm the tests fail each time (at this stage the constraint removal is caught by the schema test; it is re-checked through the API in T044); restore and record the result in `AI_LOG.md`

**Checkpoint**: User Story 1 passes on its own. This is the MVP; commit and push.

---

## Phase 4: User Story 2 - Check availability (P2)

**Purpose**: List only start times where both a bay and a qualified technician are free for the whole period. This logic also powers the alternative slots in 409 responses.

- [x] T033 [US2] Write failing unit tests `tests/unit/slot-generation.test.ts`: 15-minute grid in local time, only fully bookable starts, boundary at closing time, a day with no capacity returns an empty list
- [x] T034 [P] [US2] Write failing integration tests `tests/integration/availability.test.ts`: booked times disappear, empty result is not an error, unknown dealership gives 404
- [x] T035 [P] [US2] Write failing contract test `tests/contract/availability.contract.test.ts` for `GET /availability`
- [x] T036 [US2] Implement `src/domain/slot-generation.ts` (pure) and `src/services/availability.ts` (fetches intervals, computes slots, with a trace span and a duration metric)
- [x] T037 [US2] Implement `GET /availability`, `GET /dealerships` and `GET /service-types` in `src/api/routes/availability.ts` and `reference.ts`

---

## Phase 5: User Story 3 - Correct under simultaneous requests (P1)

**Purpose**: Exactly one of many concurrent requests for the last slot succeeds; the rest get 409 with alternatives. Placed after US2 because FR-009 (alternatives) reuses the slot logic.

- [x] T038 [US3] Write failing concurrency test `tests/integration/concurrency.test.ts`: N parallel requests (N=20, different idempotency keys) for the last slot through the real API give exactly one 201, the rest 409, and exactly one stored appointment
- [x] T039 [P] [US3] Write failing test for concurrent requests with the SAME idempotency key: one appointment, every caller gets the same appointment ID
- [x] T040 [P] [US3] Write failing tests for bounded retry: a constraint violation (`23P01`) triggers at most 3 attempts, recomputing the choice each time, then returns 409
- [x] T041 [P] [US3] Write failing tests for alternatives: a 409 includes up to 5 slots in time order, from the requested day first and then the next 7 days; when the requested day is full but a later day in the window has room, alternatives come from that later day; empty only when nothing is free in the whole 8-day window
- [x] T042 [US3] Implement bounded retry and `23P01` handling in `src/services/booking.ts`, with a retry counter metric
- [x] T043 [US3] Add alternatives to the conflict response using `src/services/availability.ts`
- [x] T044 [US3] Run `npm run test:concurrency` (script added in T001) 20 times in a row to check for flakiness. Then remove the exclusion constraints and confirm the concurrency test fails through the API, restore them, and record both results in `AI_LOG.md`

---

## Phase 6: User Story 4 - View and cancel (P3)

**Purpose**: Cancelling frees the bay and technician and keeps the record.

- [x] T045 [US4] Write failing integration tests `tests/integration/cancel.test.ts`: cancel then rebook the same slot succeeds; cancelling twice returns the same cancelled record; cancelled appointment is still retrievable; unknown ID gives 404
- [x] T046 [P] [US4] Write failing contract test for `POST /appointments/{id}/cancel`
- [x] T047 [US4] Implement `src/services/cancel.ts` and the cancel route in `src/api/routes/appointments.ts`

---

## Phase 7: User Story 5 - Block a bay or technician (P2)

**Purpose**: Bays and technicians can be blocked for a time range, and are never assigned during it (FR-015, SC-006).

- [x] T048 [US5] Write failing integration tests `tests/integration/unavailability.test.ts`: a blocked bay or technician is never assigned; availability excludes blocked time; creating a block over an existing confirmed appointment gives 409; overlapping blocks on one resource are rejected
- [x] T049 [US5] Write failing race test with a forced interleaving: hold the booking transaction open after it reads unavailability (test hook or `pg_sleep`), start the unavailability request in parallel, then let both finish; afterwards the appointment and the block never overlap (proves the row-lock design deterministically)
- [x] T050 [P] [US5] Write failing contract tests for `POST /bays/{id}/unavailability` and `POST /technicians/{id}/unavailability`
- [x] T051 [US5] Implement `src/services/unavailability.ts` taking the same row lock as booking, and the routes in `src/api/routes/unavailability.ts`
- [x] T052 [US5] Extend `src/services/booking.ts` and `src/services/availability.ts` to check unavailability inside the transaction
- [x] T053 [US5] Break-the-logic check: remove the row lock and confirm the forced-interleaving race test fails every time (not just sometimes), restore, and record the result in `AI_LOG.md`

---

## Phase 8: Polish and submission deliverables

**Purpose**: Documentation, performance check and the assessment artifacts.

- [ ] T054 Write `docs/system-design.md`: architecture diagram (Mermaid), component roles, data flow, technology choices with justification (from `research.md`), observability strategy, and the GenAI-in-design section
- [x] T055 [P] Add `docs/examples.sh` with cURL examples for every scenario in `quickstart.md`
- [x] T056 [P] Add a performance smoke test `tests/integration/perf.test.ts`: 50 concurrent bookings and availability queries stay within the plan's p95 targets (booking 300 ms, availability 200 ms)
- [ ] T057 Run the full suite, `npm run lint`, `npm run typecheck` and `redocly lint`; fix everything
- [x] T058 Run every scenario in `quickstart.md` by hand against the running service and fix any doc drift
- [ ] T059 Write `README.md`: build, run and test instructions and the AI Collaboration Narrative (strategy, verification, mistakes caught, quality), built from `AI_LOG.md`
- [ ] T060 Final `AI_LOG.md` cleanup (replace the guidance paragraph, keep real entries) and run `/speckit-analyze` to cross-check spec, plan and tasks
- [ ] T061 Draft the 5-10 minute video script: introduction, design walkthrough, implementation highlights, AI collaboration story (1-2 min), demo, lessons learned

---

## Dependencies and order

- Phase 1 then Phase 2 (blocking) then user stories.
- **US1** needs Phase 2 only.
- **US2** needs Phase 2 and the repositories from US1.
- **US3** needs **US1 and US2**: conflict alternatives (FR-009) reuse the availability logic. It is P1 in the spec but is built after US2 for that reason. This is a dependency order, not a priority change (owner-approved, 2026-11-04).
- **US4** needs US1 only and can run in parallel with US2 or US3.
- **US5** needs US1 and US2 (it extends booking and availability).
- **Phase 8** needs everything; `docs/system-design.md` can start earlier because it only draws on plan.md and research.md.

## Parallel examples

- Phase 1: the four `[P]` setup tasks together.
- Phase 2: time-range and working-hours tests are independent of the schema work.
- US1: the four test-writing `[P]` tasks together, before any implementation.
- US2 and US4 can be developed side by side once US1 is done.

## Implementation strategy

1. **MVP**: Phases 1-3. A working, tested booking API is already a submittable result.
2. Add US2, then US3 (the concurrency story is the strongest evidence of engineering care).
3. Add US4 and US5.
4. Phase 8 deliverables. Reserve real time for the README narrative and the video.
5. Commit after each task or small group, so the history shows tests, then implementation, then fixes.
