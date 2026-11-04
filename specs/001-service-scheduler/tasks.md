# Tasks: Unified Service Scheduler

**Input**: `specs/001-service-scheduler/` (plan.md, spec.md, research.md, data-model.md, contracts/openapi.yaml, quickstart.md)

**Tests**: Required. The constitution mandates test-first and SC-005 requires every acceptance scenario to be covered. Write each test task, watch it fail, then implement.

**Format**: `- [ ] T### [P?] [Story?] Description with file path`. `[P]` means it touches different files and has no unfinished dependency, so it can run in parallel.

**Scope**: backend only. The thin frontend is a separate spec and cycle after this one.

**AI log**: after each checkpoint, add an `AI_LOG.md` entry (what the AI produced, what was wrong, what you decided, how it was verified).

## Phase 1: Setup

**Purpose**: Project skeleton and tooling

- [ ] T001 Create the project skeleton per plan.md: `package.json` (scripts: dev, build, start, migrate, seed, test, test:concurrency, lint, typecheck), `tsconfig.json` (strict), `.nvmrc` (24), `src/` and `tests/` folders
- [ ] T002 [P] Install pinned dependencies in `package.json`: fastify, zod, fastify-type-provider-zod, @fastify/swagger, kysely, pg, pino, prom-client, @opentelemetry/sdk-node and instrumentations; dev: typescript, tsx, vitest, testcontainers, @testcontainers/postgresql, eslint, prettier, @redocly/cli
- [ ] T003 [P] Configure ESLint and Prettier in `eslint.config.js` and `.prettierrc`
- [ ] T004 [P] Add `docker-compose.yml` (Postgres 16 with healthcheck) and `.env.example` (no real secrets)
- [ ] T005 [P] Configure Vitest in `vitest.config.ts` with separate `unit` and `integration` projects (integration timeout 60s)

---

## Phase 2: Foundational (blocks all user stories)

**Purpose**: Schema, shared domain primitives, API skeleton and observability. No user story can start before this is done.

- [ ] T006 Write failing config tests in `tests/unit/config.test.ts` (missing or invalid env vars are rejected at startup)
- [ ] T007 Implement `src/config.ts` with Zod-validated environment config
- [ ] T008 Write failing integration test `tests/integration/schema.constraints.test.ts` using Testcontainers: overlapping bay rejected, overlapping technician rejected, back-to-back allowed, cancelled frees the slot, duplicate idempotency key rejected, empty and inclusive-upper periods rejected (the 10 scenarios already verified by hand against `data-model.md`)
- [ ] T009 Create migration `src/db/migrations/001_init.ts` with all tables, `btree_gist`, the two exclusion constraints, the period CHECK and the unavailability exclusion constraints exactly as in `data-model.md`
- [ ] T010 Add Kysely instance, generated or hand-written table types and a migrate runner in `src/db/index.ts`, `src/db/types.ts`, `src/db/migrate.ts`
- [ ] T011 Add Testcontainers helper `tests/integration/helpers/db.ts` (start Postgres, run migrations, truncate between tests)
- [ ] T012 Add SAMPLE seed data in `src/db/seed.ts`: 2 dealerships in different time zones with weekly hours, bays, technicians with skills, service types (some with buffer), customers and vehicles. Every record name is prefixed `SAMPLE`
- [ ] T013 [P] Write failing unit tests `tests/unit/time-range.test.ts`: half-open overlap, back-to-back is not overlap, containment, empty range
- [ ] T014 Implement `src/domain/time-range.ts`
- [ ] T015 [P] Write failing unit tests `tests/unit/working-hours.test.ts`: dealership-local opening hours, 15-minute alignment, whole occupied period inside one day's hours, DST change day, closed weekday
- [ ] T016 Implement `src/domain/working-hours.ts`
- [ ] T017 Add the error model in `src/api/errors.ts`: the single error JSON shape and code-to-HTTP-status mapping from `contracts/openapi.yaml`, plus the Fastify error handler
- [ ] T018 Add observability base in `src/observability/`: pino logger with request ID (`x-request-id` or generated) and PII-safe serializers, Prometheus registry, OpenTelemetry bootstrap (console exporter by default, OTLP via env)
- [ ] T019 Write failing test `tests/integration/observability.test.ts`: every log line carries the request ID, and no log line contains a customer name or VIN
- [ ] T020 Build the Fastify app in `src/server.ts` and `src/api/app.ts` with `/health`, `/ready` (DB check), `/metrics`, Zod type provider and Swagger
- [ ] T021 Add contract-test helper `tests/contract/helpers.ts` that validates a response against `contracts/openapi.yaml`

**Checkpoint**: migrations apply on a fresh Postgres, the constraint tests pass, the server starts and `/health` responds. Add the first `AI_LOG.md` implementation entry.

---

## Phase 3: User Story 1 - Book a service appointment (P1) MVP

**Purpose**: A booking is confirmed only when a bay and a qualified technician are free for the whole occupied period; otherwise nothing is stored.

- [ ] T022 [US1] Write failing unit tests `tests/unit/occupied-period.test.ts`: duration plus buffer (including zero buffer) gives the right period
- [ ] T023 [P] [US1] Write failing unit tests `tests/unit/resource-selection.test.ts`: fewest appointments on the dealership-local date wins, ties go to the lowest ID, a technician without the required skill is never chosen
- [ ] T024 [P] [US1] Write failing integration tests `tests/integration/booking.test.ts`: happy path links customer, vehicle, technician and bay; no free bay gives 409; no qualified technician gives 409; skill mismatch; back-to-back accepted; outside hours; start in the past; unknown references give 404; vehicle not owned by the customer gives 422; nothing is stored on failure
- [ ] T025 [P] [US1] Write failing idempotency tests `tests/integration/idempotency.test.ts`: same key and body returns the original with `Idempotent-Replayed`; same key and different body gives 422; a 409 stores nothing so a retry is re-evaluated
- [ ] T026 [P] [US1] Write failing contract test `tests/contract/appointments.contract.test.ts` for `POST /appointments` (201, 200 replay, 404, 409, 422)
- [ ] T027 [US1] Implement `src/domain/occupied-period.ts` and `src/domain/resource-selection.ts`
- [ ] T028 [US1] Implement repositories `src/db/repositories/appointments.ts`, `resources.ts`, `reference.ts`
- [ ] T029 [US1] Implement `src/services/booking.ts`: one transaction, row locks on the chosen bay and technician in fixed order (bay then technician by ID), insert, idempotency handling via the unique key and request hash
- [ ] T030 [US1] Implement `POST /appointments` and `GET /appointments/{id}` in `src/api/routes/appointments.ts` with Zod schemas, required `Idempotency-Key` header and error mapping
- [ ] T031 [US1] Add booking metrics (outcome counter by result, duration histogram) and a trace span around the booking transaction in `src/services/booking.ts`
- [ ] T032 [US1] Break-the-logic check: temporarily remove the overlap check and, separately, the exclusion constraint; confirm the tests fail each time; restore and record the result in `AI_LOG.md`

**Checkpoint**: User Story 1 passes on its own. This is the MVP; commit and push.

---

## Phase 4: User Story 2 - Check availability (P2)

**Purpose**: List only start times where both a bay and a qualified technician are free for the whole period. This logic also powers the alternative slots in 409 responses.

- [ ] T033 [US2] Write failing unit tests `tests/unit/slot-generation.test.ts`: 15-minute grid in local time, only fully bookable starts, boundary at closing time, a day with no capacity returns an empty list
- [ ] T034 [P] [US2] Write failing integration tests `tests/integration/availability.test.ts`: booked times disappear, unavailable resources are respected, empty result is not an error, unknown dealership gives 404
- [ ] T035 [P] [US2] Write failing contract test `tests/contract/availability.contract.test.ts` for `GET /availability`
- [ ] T036 [US2] Implement `src/domain/slot-generation.ts` (pure) and `src/services/availability.ts` (fetches intervals, computes slots, with a trace span and a duration metric)
- [ ] T037 [US2] Implement `GET /availability`, `GET /dealerships` and `GET /service-types` in `src/api/routes/availability.ts` and `reference.ts`

---

## Phase 5: User Story 3 - Correct under simultaneous requests (P1)

**Purpose**: Exactly one of many concurrent requests for the last slot succeeds; the rest get 409 with alternatives. Placed after US2 because FR-009 (alternatives) reuses the slot logic.

- [ ] T038 [US3] Write failing concurrency test `tests/integration/concurrency.test.ts`: N parallel requests (N=20, different idempotency keys) for the last slot through the real API give exactly one 201, the rest 409, and exactly one stored appointment
- [ ] T039 [P] [US3] Write failing test for concurrent requests with the SAME idempotency key: one appointment, every caller gets the same appointment ID
- [ ] T040 [P] [US3] Write failing tests for bounded retry: a constraint violation (`23P01`) triggers at most 3 attempts, recomputing the choice each time, then returns 409
- [ ] T041 [P] [US3] Write failing test that a 409 includes up to 5 alternative slots, and none when there is no capacity anywhere that day
- [ ] T042 [US3] Implement bounded retry and `23P01` handling in `src/services/booking.ts`, with a retry counter metric
- [ ] T043 [US3] Add alternatives to the conflict response using `src/services/availability.ts`
- [ ] T044 [US3] Add `npm run test:concurrency` and run it 20 times in a row to check for flakiness; record the result in `AI_LOG.md`

---

## Phase 6: User Story 4 - View and cancel (P3)

**Purpose**: Cancelling frees the bay and technician and keeps the record.

- [ ] T045 [US4] Write failing integration tests `tests/integration/cancel.test.ts`: cancel then rebook the same slot succeeds; cancelling twice returns the same cancelled record; cancelled appointment is still retrievable; unknown ID gives 404
- [ ] T046 [P] [US4] Write failing contract test for `POST /appointments/{id}/cancel`
- [ ] T047 [US4] Implement `src/services/cancel.ts` and the cancel route in `src/api/routes/appointments.ts`

---

## Phase 7: Resource unavailability - FR-015 (no user story in the spec yet)

**Purpose**: Bays and technicians can be blocked for a time range. Tagged by requirement because the spec has no user story for FR-015 (see summary).

- [ ] T048 [FR-015] Write failing integration tests `tests/integration/unavailability.test.ts`: a blocked bay or technician is never assigned; availability excludes blocked time; creating a block over an existing confirmed appointment gives 409; overlapping blocks on one resource are rejected
- [ ] T049 [FR-015] Write failing race test: a booking and an unavailability request for the same resource and time run in parallel; afterwards the two never overlap (proves the row-lock design)
- [ ] T050 [P] [FR-015] Write failing contract tests for `POST /bays/{id}/unavailability` and `POST /technicians/{id}/unavailability`
- [ ] T051 [FR-015] Implement `src/services/unavailability.ts` taking the same row lock as booking, and the routes in `src/api/routes/unavailability.ts`
- [ ] T052 [FR-015] Extend `src/services/booking.ts` and `src/services/availability.ts` to check unavailability inside the transaction
- [ ] T053 [FR-015] Break-the-logic check: remove the row lock, confirm the race test can fail, restore, and record the result in `AI_LOG.md`

---

## Phase 8: Polish and submission deliverables

**Purpose**: Documentation, performance check and the assessment artifacts.

- [ ] T054 Write `docs/system-design.md`: architecture diagram (Mermaid), component roles, data flow, technology choices with justification (from `research.md`), observability strategy, and the GenAI-in-design section
- [ ] T055 [P] Add `docs/examples.sh` with cURL examples for every scenario in `quickstart.md`
- [ ] T056 [P] Add a performance smoke test `tests/integration/perf.test.ts`: 50 concurrent bookings and availability queries stay within the plan's p95 targets (booking 300 ms, availability 200 ms)
- [ ] T057 Run the full suite, `npm run lint`, `npm run typecheck` and `redocly lint`; fix everything
- [ ] T058 Run every scenario in `quickstart.md` by hand against the running service and fix any doc drift
- [ ] T059 Write `README.md`: build, run and test instructions and the AI Collaboration Narrative (strategy, verification, mistakes caught, quality), built from `AI_LOG.md`
- [ ] T060 Final `AI_LOG.md` cleanup (replace the guidance paragraph, keep real entries) and run `/speckit-analyze` to cross-check spec, plan and tasks
- [ ] T061 Draft the 5-10 minute video script: introduction, design walkthrough, implementation highlights, AI collaboration story (1-2 min), demo, lessons learned

---

## Dependencies and order

- Phase 1 then Phase 2 (blocking) then user stories.
- **US1** needs Phase 2 only.
- **US2** needs Phase 2 and the repositories from US1.
- **US3** needs **US1 and US2**: conflict alternatives (FR-009) reuse the availability logic. It is P1 in the spec but is built after US2 for that reason.
- **US4** needs US1 only and can run in parallel with US2 or US3.
- **FR-015** needs US1 and US2 (it extends booking and availability).
- **Phase 8** needs everything; `docs/system-design.md` can start earlier because it only draws on plan.md and research.md.

## Parallel examples

- Phase 1: the four `[P]` setup tasks together.
- Phase 2: time-range and working-hours tests are independent of the schema work.
- US1: the four test-writing `[P]` tasks together, before any implementation.
- US2 and US4 can be developed side by side once US1 is done.

## Implementation strategy

1. **MVP**: Phases 1-3. A working, tested booking API is already a submittable result.
2. Add US2, then US3 (the concurrency story is the strongest evidence of engineering care).
3. Add US4 and FR-015.
4. Phase 8 deliverables. Reserve real time for the README narrative and the video.
5. Commit after each task or small group, so the history shows tests, then implementation, then fixes.
