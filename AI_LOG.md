# AI Log

One entry per meaningful AI interaction. Aim for 8-12 entries, including at least
2-3 where the AI was wrong and 1-2 where I overruled it. Feeds the README narrative.

## Template

### YYYY-MM-DD: <short title>

- **Phase:** design | tests | implementation | review | docs
- **Asked:** what I asked the AI to do
- **AI produced:** summary of the output
- **Problem / gap:** what was wrong, missing or risky (or "none")
- **My decision:** accepted | corrected | rejected, and why
- **Verified by:** test, cURL run, manual diff review, broken-logic check

## Entries

### 2026-11-04: Repo setup and first spec

- **Phase:** design
- **Asked:** set up repo, Spec Kit, constitution draft, AI log template; then start the spec
- **AI produced:** repo scaffold, 7-principle constitution draft, and specs/001-service-scheduler/spec.md written from the PDF's Scenario A
- **Problem / gap:** AI found an older project folder (keyloop-unified-service-scheduler) and stopped to ask instead of overwriting. The spec was drafted without a user-written problem statement, so its assumptions are the AI's guesses
- **My decision:** Reviewed the constitution draft and the spec's assumptions and accepted them, apart from the answers I gave in the clarify session (next entry)
- **Verified by:** read the files myself; the spec was then tightened through a 5-question clarify session, with the answers recorded in its Clarifications section

### 2026-11-04: Clarify session

- **Phase:** design
- **Asked:** run /speckit-clarify on the draft spec
- **AI produced:** targeted questions, each with a recommended option
- **Problem / gap:** Q3 (resource availability): AI recommended "opening hours only" to keep scope small
- **My decision:** Q1 accepted AI's recommendation (auto-assign). Q2 accepted (per-type buffer). Q3 overruled: chose per-resource unavailability for realism, accepting more schema and tests. Q4 accepted (idempotency key). Q5 accepted (least-booked, ties by lowest ID)
- **Verified by:** spec updated (FR-015, new entity); reviewed in git diff

### 2026-11-04: Technical plan

- **Phase:** design
- **Asked:** run /speckit-plan using my defaults: Fastify, Kysely + SQL migrations, transaction + Postgres exclusion constraint with bounded retry
- **AI produced:** plan.md, research.md (11 decisions with alternatives), data-model.md, contracts/openapi.yaml, quickstart.md
- **Problem / gap:** AI added choices beyond my defaults: Vitest, Testcontainers, OpenTelemetry, Zod, "whole service must fit in one day's opening hours", and rejecting (409) an unavailability period that overlaps existing appointments. Also found that an appointment-only exclusion constraint cannot cover unavailability periods (race), so it proposed row locks FOR UPDATE on the chosen bay and technician
- **My decision:** Accepted all the extras: row locks for unavailability, 409 (not auto-cancel) when an unavailability period overlaps existing appointments, whole service within one day's opening hours, and Vitest, Testcontainers, Zod and OpenTelemetry
- **Verified by:** see the next entry (SQL, concurrency and OpenAPI checks were run afterwards)

### 2026-11-04: Verify the plan's SQL and contract

- **Phase:** design / verification
- **Asked:** re-check the items marked "not yet verified": SQL in data-model.md, Docker daemon, OpenAPI contract
- **AI produced:** a throwaway Postgres 16 container, 10 SQL scenario checks, a 20-way parallel insert race, and a Redocly lint of the contract
- **Problem / gap:** the AI's own test harness was wrong three times (a malformed UUID, a failed macOS `sed -i`, then a `head -12` that cut off a constraint and made a CHECK attach to the wrong ALTER). Those runs showed false failures and were discarded. The fix was to extract the SQL block from data-model.md verbatim instead of retyping it. Separately, the contract had 11 lint errors: no explicit `security: []`, despite auth being out of scope, and no `operationId`s
- **My decision:** Did not accept the 7 style warnings. Fixed the license and server URL; turned off the "4XX response" rule for the 5 endpoints with no client-error case (health, ready, metrics, two reference lists) rather than document errors the service will never return
- **Verified by:** verbatim doc SQL: 10/10 scenarios behave as designed (overlap rejected on bay and technician, back-to-back allowed, cancel frees the slot, duplicate key rejected, empty and inclusive-upper periods rejected). 20 parallel inserts for one slot: 1 confirmed, 19 rejected by `appointment_no_bay_overlap`. OpenAPI: valid after fix; 0 errors and 0 warnings after the second pass (with a documented rule exception)
- **Lesson for the narrative:** a green or red result is only as trustworthy as the test harness. Check that the thing under test is the real artifact

### 2026-11-04: Task breakdown

- **Phase:** design
- **Asked:** run /speckit-tasks with tests before implementation
- **AI produced:** tasks.md with 61 tasks in 8 phases; format-checked with a regex (all 61 match)
- **Problem / gap:** AI found that FR-015 (resource unavailability) belongs to no user story in the spec, so tagged those 6 tasks `[FR-015]` instead of inventing a story. Also reordered: US3 (P1) comes after US2 (P2) because the conflict alternatives (FR-009) reuse the availability logic
- **My decision:** Fixed the gap at the source: added User Story 5 (block a bay or technician, P2) and SC-006 to the spec, so the 6 tasks are now tagged [US5]. Kept US2 before US3 as a documented dependency (not a priority change)
- **Verified by:** format regex re-run after retagging (61/61 valid, 0 leftover [FR-015] tags); spec and tasks now trace every story to a phase

### 2026-11-04: Cross-artifact analysis and fixes

- **Phase:** design / verification
- **Asked:** run /speckit-analyze (read-only) across spec, plan, tasks, data model, contract and constitution
- **AI produced:** 14 findings (0 critical, 1 high, 8 medium, 5 low) and 100% requirement coverage, with 4 requirements only partly covered
- **Problem / gap:** HIGH: SC-003 required an alternative "where capacity exists elsewhere" but the planned test returned none when the day was full, so the two contradicted each other. Others: a US2 test depending on US5 code; two tests ordered after their implementation or before their test harness; no HTTP status for validation errors; no tests for malformed input, cross-dealership resources or GET by ID; break-the-logic checks that could only fail "sometimes"; constitution still marked DRAFT
- **My decision:** Alternatives = up to 5 slots, the requested day first, then the next 7 days. Approved the rest of the fixes. AI chose two details I accepted: 400 for malformed requests vs 422 for business-rule breaks, and "replay after cancel returns the cancelled record"
- **Verified by:** task format regex (61/61), Phase 2 order re-read, Redocly lint (0 errors, 0 warnings), grep for leftover terms

### 2026-11-04: Phase 1 setup (T001-T005)

- **Phase:** implementation
- **Asked:** start implementation with Phase 1: skeleton, pinned dependencies, lint/format, Docker Compose, Vitest
- **AI produced:** package.json and strict tsconfig, 24 exact-pinned dependencies, ESLint/Prettier config, Postgres compose file, Vitest with unit and integration projects
- **Problem / gap:** the AI looked up current versions first instead of using remembered ones. That found TypeScript 7.0.2 is the latest, but typescript-eslint only supports below 6.1, so TypeScript was pinned to 6.0.3 (the version table would otherwise have installed an unsupported compiler). Also: `test:integration` exits 1 when a project has no tests yet; the AI added a temporary `passWithNoTests` and put its removal into task T010 so a missing test file can never pass silently later
- **My decision:** Accepted both: keep TypeScript 6.0.3 until typescript-eslint supports 7; the temporary `passWithNoTests` was fine and was removed in T010
- **Verified by:** `npm ls` (no peer conflicts), `npm audit` (0 vulnerabilities), typecheck, lint and Prettier clean, a throwaway smoke test, and the compose database actually booted healthy on Postgres 16.15 and was torn down

### 2026-11-04: Config and database schema (T006-T011)

- **Phase:** implementation
- **Asked:** continue Phase 2 test-first: config, Kysely plumbing, Testcontainers helper, schema tests, migration
- **AI produced:** Zod config that lists every problem but never echoes values; typed Kysely layer; migration with the exclusion constraints; 15 config tests and 18 schema tests against a real Postgres 16
- **Problem / gap:** (1) Kysely 0.29 moved `Migrator` to `kysely/migration`; the compile error pointed straight at it. (2) The linter flagged a rethrown error with no `cause`, which would have hidden the original Postgres error. (3) The AI left a junk destructuring line in the schema test that did not compile, and removed it. (4) The migration added constraints (service duration > 0, weekday range, close after open, unavailability period checks) that were not in data-model.md; the doc was updated to match
- **My decision:** Accepted the extra database rules (service duration over zero, buffer not negative, weekday range, closing after opening, unavailability period checks); data-model.md was updated so the doc and code agree
- **Verified by:** all tests were seen red first (config: module missing; schema: `relation "dealership" does not exist`), then green. Break-the-logic: removing the technician constraint, ignoring status in the bay constraint, and accepting inclusive bounds each failed exactly the intended tests (1, 2 and 1) and passed again once restored. A deliberate secret leak into the config error was caught by the no-leak test

### 2026-11-04: Seed data and time logic (T012-T016)

- **Phase:** implementation
- **Asked:** continue Phase 2: SAMPLE seed data, then the pure domain logic for time ranges and working hours, tests first
- **AI produced:** re-runnable seed with fixed IDs; half-open `TimeRange`; DST-aware local-time conversion built on `Intl` (Node 24 has no stable Temporal); 69 unit tests. Expected values were derived from calendar facts (London springs forward 2030-03-31, New York 2030-03-10), not from running the code
- **Problem / gap:** the seed's command-line entry point was only trusted after running `npm run migrate` and `npm run seed` for real against the compose database. Break-the-logic: closing the range (touching counts as overlap), ignoring DST, and choosing the later of two ambiguous times each failed 2, 10 and 1 tests. A fourth break (measuring 15-minute alignment in UTC instead of local time) SURVIVED. Investigation showed it is an equivalent mutant: every real zone offset is a multiple of 15 minutes, so no test can tell the two apart. The test title had overclaimed, so it was retitled honestly rather than bent to fail
- **My decision:** Accepted all: the `Intl`-based time conversion, earlier moment for a local time that happens twice, forward shift for one that never happens, and the honest retitle of the equivalent-mutant test instead of forcing it to fail
- **Verified by:** tests seen red first (modules missing), then green; four deliberate breaks, three caught, one analysed as equivalent; seed and migrate commands run for real, including exit code 1 on bad config

### 2026-11-04: Error model (T017)

- **Phase:** implementation
- **Asked:** implement the single error shape and the code-to-status table (task list had no test task, so the AI wrote tests first anyway under the constitution's test-first rule)
- **AI produced:** `AppError`, the status table as the single source, and a Fastify error handler; 24 tests including privacy checks (validation errors never echo the submitted value; a 500 never leaks the internal message)
- **Problem / gap:** the AI had written in a code comment that Node's JSON errors can quote the request body, and added a test for it. A deliberate break (echo the framework message) did NOT fail that test. Probing Fastify 5.12.8 directly showed it does not quote the body at all, so the AI's stated reason was wrong. The generic message was kept as defence in depth, the false comment was corrected, and the test was reworded to state the end-to-end guarantee it actually gives
- **My decision:** Accepted: errors never echo what the caller sent, and a 500 hides the internal message and is logged with the request ID.
- **Verified by:** tests seen red (module missing) then green; five deliberate breaks: leak on 500, echo body in details, swallow errors, wrong status, each caught by the intended test(s); the sixth (echo framework message) survived and was investigated with a direct probe instead of assumed

### 2026-11-04: Observability, app skeleton and contract helper (T018-T021)

- **Phase:** implementation (Phase 2 checkpoint reached)
- **Asked:** continue autonomously through the rest of Phase 2 while the owner rests; note anything needing a decision
- **AI produced:** request IDs on every log line (caller IDs validated against log injection), PII-safe logs (no body, headers, query string or database error `detail`), per-app Prometheus metrics with bounded labels, `withSpan` tracing helper, a Fastify app with `/health`, `/ready` (with timeout) and `/metrics`, a graceful-shutdown server entry, and a contract-test helper that validates real responses against `openapi.yaml`
- **Problem / gap:** (1) `SimpleSpanProcessor` in OpenTelemetry v3 takes `{ exporter }`; the AI wrote the old call in both the code and the test. (2) Span parent/child links need a context manager that `NodeSDK` registers in production; the bare test provider lacked it, which needed one more pinned dev dependency. (3) Two of the AI's break-the-logic runs never executed: macOS has no `timeout` command (exit 127), and a Python search string no longer matched after Prettier reformatted the line. In both cases the empty or "all passed" output was nearly read as evidence; both were rerun properly. (4) Declared dependencies: `@opentelemetry/sdk-trace` and `context-async-hooks` were only transitive, so they were added as direct, exact-pinned dependencies
- **My decision:** Accepted all: `/ready` returns a plain status (503 when the database is down) instead of the error shape; every operation has a `default` response for unexpected 5xx only; the observability test lives in `tests/unit/`; tracing stays manual spans only. (see the list of open decisions below)
- **Open decisions for the owner:**
  1. `/ready` returns `{ "status": "unavailable" }` with 503, not the standard error shape, because liveness/readiness probes expect a simple status. OK?
  2. The contract now gives every operation a `default` response for unexpected 5xx errors (4xx are never covered by it, so an undocumented 409 fails the contract test). OK?
  3. The observability test lives in `tests/unit/` (no database needed) instead of `tests/integration/` as the task said. OK?
  4. OpenTelemetry auto-instrumentation of `pg` and `http` is configured, but in an ESM project it may need an extra loader flag to produce spans; only the manual `withSpan` spans are guaranteed. This has NOT been verified yet and is planned for the final manual check
- **Verified by:** all tests seen red first, then green; break-the-logic: observability (6 breaks, all caught), app readiness (3 breaks, all caught after the rerun), contract helper (6 permissive breaks, all caught after the rerun); the compiled server was started against the compose database and called with `curl` (health, ready, custom request ID, metrics, SIGTERM exit code 0, JSON logs carrying the request ID). Full suite: 171 tests, typecheck, ESLint, Prettier and the contract lint all clean

### 2026-11-04: User Story 1, booking (T022-T032)

- **Phase:** implementation (MVP)
- **Asked:** continue autonomously: pure domain logic, repositories, booking service, routes, metrics, and a thorough break-the-logic pass
- **AI produced:** `occupiedPeriod` and `rankByLeastBooked` (pure, unit-tested), repositories, a booking service (one transaction per attempt: choose, lock, re-check, insert), `POST /appointments` and `GET /appointments/{id}`, outcome metrics, a span, and PII-free logs. 70 new tests (unit, integration against real Postgres, contract)
- **Problem / gap:**
  1. **Design deviation (needs your decision):** the approved plan said "lock the chosen bay and technician, retry 3 times". The AI reasoned that this gives false "no capacity" answers under load (every contender chases the same best candidate) and implemented `FOR UPDATE SKIP LOCKED` instead. Documented in research.md decision 2 as pending your confirmation.
  2. The first run had 4 failures, all from one fixture bug: the schema (correctly) requires unique skill names and the fixture reused one. Fixed the fixture, not the code.
  3. **Break-the-logic found three test gaps, not code bugs.** Removing the bay dealership filter survived, because the technician filter still produced the same 409. Making the SQL overlap check inclusive at the end survived, because the back-to-back test only ever booked the later slot second. Both were found by mutation, then closed with new tests (cross-dealership with a shared skill, and "earlier slot booked second"). A third (technician dealership filter) was then confirmed caught.
  4. **Masked layers (honest finding):** removing only the app-level overlap check, only the DB exclusion constraints, or only the re-check under lock leaves ALL sequential tests green, because each layer backstops the others. Removing both app check and constraint fails 8 tests. So sequential tests cannot justify the constraint on their own; the concurrency test (US3) must, and T044 will re-check it through the API.
  5. The booking service imports `AppError` from the API layer, a small layering inversion kept for simplicity.
- **My decision:** Accepted both: non-waiting locks (`FOR NO KEY UPDATE SKIP LOCKED`) instead of the blocking locks in the approved plan, and the small layering shortcut where the booking service imports the API layer's error type.
- **Open decisions for the owner:** (a) approve `SKIP LOCKED` over blocking locks; (b) accept the AppError layering shortcut or move errors into a shared module; (c) 3 attempts then 409 is the retry bound; raise it?
- **Verified by:** all tests red first (modules missing), then green. 17 deliberate bugs: 14 caught directly (buffer ignored 2 tests, skill filter 2, tie-break 4, least-booked 3, past check 2, hours check 7, hash 2, replay check 2, counter 1, log leak 1, both layers 8, plus the three closed gaps); 3 masked by design (A, B, O) and recorded above. Final suite for this area: 211 tests passing, typecheck, ESLint clean

### 2026-11-04: User Story 2, availability (T033-T037)

- **Phase:** implementation
- **Asked:** continue autonomously: availability as a pure function, a service, `GET /availability`, plus the two reference lists
- **AI produced:** `generateSlots` (pure, 26 unit tests), an availability service, `/availability`, `/dealerships`, `/service-types`, and an integration test that checks availability and booking AGREE for the same start times (listed means bookable, omitted means not)
- **Problem / gap:**
  1. One unit test failed on the first run and the AI's own expectation was wrong: it said 10:15 should be unavailable, but bay A is free again from 10:00, so 10:15 is correctly bookable. The expectation was corrected by hand-working the answer, not by copying the code's output, and the test now documents which bay makes 08:15 and 10:15 work.
  2. Break-the-logic: 13 deliberate bugs. Two survived and exposed real test gaps: the "nobody is qualified" test used technicians with NO skills (so the join dropped them anyway); and nothing tested a dealership with technicians but no bays while another dealership has bays. The fixture now gives "unqualified" technicians a different skill, three tests were added, and all 13 are now caught.
  3. One mutation did not apply the first time because Prettier had re-wrapped the line; this was noticed from the runner's "did not apply" message rather than read as a pass.
  4. The contract listed a 422 for `/availability` that nothing can return (a closed day is an empty list, not an error). It was removed so the contract says only what the service does.
- **My decision:** Accepted: a closed day returns `200` with an empty list, not an error.
- **Open decision for the owner:** a closed day returns `200` with an empty list. Agree, or should it be an explicit error?
- **Verified by:** tests red first, then green (189 unit, 31 integration and contract for this area); 13 mutations all caught after the two fixes; availability vs booking agreement tested for 10 start times plus a buffer and multi-resource case

### 2026-11-04: User Story 3, concurrency, retries and alternatives (T038-T044)

- **Phase:** implementation (the correctness story)
- **Asked:** continue autonomously: 20-way and 30-way races, same-key races, bounded retry, alternative slots, and a 20-run flakiness check
- **AI produced:** concurrency tests (including a cold-connection-pool variant), a retry test file driven by two test seams, alternative slots (up to 5, requested day then next 7 days), and 100+ new tests. 356 tests pass in total.
- **Problem / gap (the most instructive part of the project):**
  1. **A test deadlocked.** The AI's `FOR UPDATE` row lock on the bay and technician conflicts with the foreign-key lock any appointment insert takes, so a test hook that inserted an appointment waited on a transaction that was waiting for the hook. The diagnosis (not a guess) led to `FOR NO KEY UPDATE`, a regression test that now fails fast with a lock timeout instead of hanging, and a note in the design doc. This was a real production hazard, not just a test problem.
  2. **A same-key race the AI predicted but the HTTP tests missed.** 60 parallel requests never hit the window between the key check and the capacity check. A seam that pauses a request at that exact point reproduced it deterministically (a false 409 instead of a replay), and the fix (re-read the key before any 409) followed.
  3. **The 20-run flakiness check caught a false "no capacity"** (5 confirmed, 25 rejected, one place free). It could not be reproduced on demand (360 warm rounds and 100 cold-pool rounds: zero failures), so the AI argued from the code instead: a fixed retry count of 3 cannot be correct because a slow request can lose 3 races in a row. The retry policy became time-budgeted for contention (1 s) and stayed bounded (3) only for database-constraint rejections. A test that forces 4 stale losses now passes. After the fix the loop ran 20 of 20 clean, against 19 of 20 before. This is evidence, not proof, and the AI says so.
  4. The AI also found it had been locking a technician even after failing to lock a bay; fixed. It cannot be tested from outside (the lock lives only inside the attempt), so it is recorded as a code-reading fix and not as a tested one. A test the AI wrote for it was deleted because it could not fail.
  5. **Process slips, handled:** one command was blocked by the auto-mode classifier because it would have killed every `vitest` process and removed every `postgres:16` container on the machine, possibly belonging to other projects. It was not retried; the AI stopped only its own process by PID and relied on Testcontainers' reaper. Three scripted edits also stopped half-way because Prettier had reformatted the text being matched; each time the AI looked at the real file before finishing.
- **My decision:** Accepted all: contention is retried for up to 1 second with jittered backoff and database rejections at most 3 times; alternatives are the EARLIEST slots in time order, not the nearest to the requested time.
- **Open decisions for the owner:** (a) approve the 1 s contention budget and 3 constraint retries as the retry policy; (b) when alternatives are for a time late in the day, they are the EARLIEST slots in time order as the spec says, not the ones nearest the requested time; keep that, or prefer nearest-first?
- **Verified by:** all new tests red first; same-key race reproduced by a seam, then fixed; 20/20 flakiness runs after the fix; break-the-logic through the API: removing only the constraint, only the re-check, or only the locks is masked (52/52 pass) but removing the constraint with the re-check (12 fail), or locks with the constraint (39 fail), or all three (39 fail) is caught. Each safety layer is justified by a test that fails without it in combination.

### 2026-11-04: User Stories 4 and 5, cancel and blocking (T045-T053)

- **Phase:** implementation
- **Asked:** continue autonomously: cancel, then block a bay or technician, proving the row-lock design with forced interleavings (the earlier analysis said a race that "can sometimes fail" is weak evidence)
- **AI produced:** atomic idempotent cancel (one `UPDATE ... WHERE status = 'confirmed'`); block endpoints for bays and technicians; booking, availability and the re-check under the lock all respect blocks; a new error code `UNAVAILABILITY_OVERLAP` so a client can tell "overlaps an appointment" from "overlaps another block". 72 new tests (428 total).
- **Problem / gap:**
  1. **The race proofs are deterministic, not lucky.** One test freezes a booking after it read its candidates, commits a block, then lets the booking carry on: it must refuse to insert. Another starts a block while a booking holds its locks and polls `pg_stat_activity` until Postgres confirms the block is genuinely waiting, so the test cannot pass by the block merely running later. Removing the re-check fails the first test every time.
  2. **Break-the-logic found a test weakness again:** ignoring technician blocks in the free list survived 91 tests. The tests blocked the first-created technician, but candidates are ranked by lowest random UUID, so half the time the blocked one would not have been chosen anyway. The fixture index now follows the ranking, and the mutation fails deterministically. Lesson: a test that blocks a resource nobody would pick proves nothing.
  3. A scripted edit stopped half-way (Prettier had re-wrapped the matched text) and left the contract partly updated; it was caught by re-reading the real YAML, and the contract/code enum-agreement test would have failed if the two had stayed out of step.
  4. Design choices made along the way: end-before-start on a block is a 400 (malformed), not a 422, so those endpoints never return 422 and the contract no longer lists it; a block may start in the past (someone called in sick this morning); cancelling a past appointment is allowed (the spec is silent).
- **My decision:** Accepted the new error code `UNAVAILABILITY_OVERLAP`, blocks that start in the past, and cancelling an appointment that has already started. Chose to ADD endpoints to list and remove blocks, which closes the gap this entry flagged (done in the entry "Listing and removing blocks" below).
- **Open decisions for the owner:** (a) the new `UNAVAILABILITY_OVERLAP` code; (b) blocks may start in the past; (c) cancelling an appointment that has already started or passed is allowed; (d) there is no endpoint to list or delete blocks (the contract has none); is that enough for the demo?
- **Verified by:** all tests red first; 4 cancel mutations and 11 unavailability mutations, all caught after the fixture fix (the closed-range, no-lock, check-before-lock and leaks-a-500 bugs each fail specific tests); full suite 428 tests, typecheck, ESLint, Prettier and the contract lint clean.

### 2026-11-04: Performance check and the hands-on run (T055, T056, T058)

- **Phase:** verification
- **Asked:** continue autonomously: a performance smoke test, a cURL walk-through of every scenario, and run all of it by hand against the real compiled service
- **AI produced:** a 50-concurrent performance test (booking p95 125 ms against a 300 ms target; availability p95 31 ms against 200 ms; mixed load also inside targets), `docs/examples.sh` covering every scenario, and a manual run against a real database with tracing on.
- **Problem / gap: the hands-on run found three real problems that 439 automated tests had not.**
  1. **Body-less JSON POSTs failed.** Cancelling returned 400 when the client sent `Content-Type: application/json` with no body (what curl with a header, axios and most fetch wrappers do). The integration tests never noticed because Fastify's `inject` adds no content type when there is no payload. Fixed test-first by dropping the declared content type on genuinely empty requests, NOT by replacing the JSON parser, because the default parser also refuses prototype-poisoning payloads (a test keeps that guarantee).
  2. **Business rejections were recorded as errors in tracing.** Nine `exception` events appeared for ordinary 409 and 422 outcomes, which would look like failures on a dashboard. `withSpan` now takes an `isExpected` predicate; rejections get `outcome=rejected` and unexpected failures are still errors.
  3. **Automatic HTTP and database tracing never worked.** Looking at what the server actually printed showed only the manual spans. In an ES-module project the instrumentation needs a loader hook registered before the app's imports. It was removed (plus two dependencies) instead of left as dead configuration, and the design doc now states the limitation. This closes the open question the AI raised at T021.
  4. **The AI's own script was fragile twice:** a stray empty argument crashed one step, and it assumed a day always has a 24th free slot, so a second run failed. It now searches forward for a weekday with room and was run three times in a row.
  5. The AI's first perf test generated bookings that were themselves invalid (a 17:00 start outside working hours); the failures were read as "my test data is wrong" and fixed, not as a service problem.
- **My decision:** Keep tracing as manual spans only; no loader hook for automatic spans.
- **Open decision for the owner:** keep tracing as manual spans only (current), or invest in the loader hook for automatic HTTP and database spans? The hook adds start-up complexity, and the Prometheus histogram plus request-ID logs already give request-level visibility.
- **Verified by:** perf test (3 tests) with numbers printed; `examples.sh` run 3 times in a row against a real Postgres with every status code matching the documented behaviour; full suite 439 tests, typecheck, ESLint, Prettier and contract lint clean; empty-body hook broken on purpose (4 existing tests fail).

### 2026-11-04: Submission documents (T054, T057, T059, T061)

- **Phase:** documentation and final verification
- **Asked:** continue autonomously: system design document, README with the AI narrative, video script, final verification
- **AI produced:** `docs/system-design.md` (three Mermaid diagrams, correctness design, technology table, observability, limitations, GenAI section), a rewritten README, an updated quickstart that matches the real commands, `docs/video-script.md`, and a final run of everything.
- **Problem / gap:**
  1. The first draft of the design document overreached in two places: it said Node/TypeScript was "required by the brief" (it was the owner's choice; the brief prescribes nothing), and it said the owner "discarded" the older project (they chose a fresh repository; the old folder was left untouched). Both were corrected on re-reading.
  2. The README draft claimed the AI "never wrote implementation before a failing test" and that the owner "can explain any line". The first is false (the booking-metrics tests came after the code and were validated afterwards by breaking it) and the second is not the AI's to assert. Both were rewritten.
  3. All three Mermaid diagrams were rendered with the real renderer rather than judged by eye.
  4. The GenAI section, the README narrative and the video script are DRAFTS written from this log and the commit history; each carries a comment asking the owner to put it in their own words.
- **My decision:** Will rewrite the GenAI section, the README narrative and the video script in their own words. The drafts stay as a starting point, with their DRAFT comments, until then.
- **Verified by:** typecheck, ESLint, Prettier, contract lint and the production build all clean; `npm audit` for production dependencies reports 0 vulnerabilities; `npm test` 439 passing (197 unit); every number quoted in the README was re-measured.

### 2026-11-04: The booking UI (specs/002-booking-ui, U01-U10)

- **Phase:** implementation (second layer, requested by the owner: "just simple")
- **Asked:** a simple frontend; backend first was done, so now the UI
- **AI produced:** a short spec and task list, then a Vite and React app: DST-aware time formatting, a typed API client, a state-light `App`, 61 tests (18 time, 12 client, 31 UI against a fake backend) and a production build of about 73 KB gzipped.
- **Decisions the AI made and flagged for the owner:** (1) customers and vehicles come from a labelled SAMPLE demo picker, because the API has no customer-listing endpoint (deliberate: personal data, no authentication); (2) the booking list is session-only, because the API has no list endpoint; (3) the dev server proxies `/api`, so the backend gained no CORS configuration.
- **Problem / gap (the real run found what 58 tests had not):**
  1. **The time list vanished and reappeared on every refresh** (measured: 0 buttons visible during a refresh). Fixed with "keep the old times while updating", plus a guard test that the old times must NOT linger when the date, dealership or service changes (they would be for the wrong thing).
  2. **After a 409 the confirmation stayed open** with a Book button that could only fail again. It now closes and offers the alternatives; for a network error it stays open on purpose, because retrying with the same key is safe.
  3. **Phone width truncated the dropdowns** ("SAMPLE Dealershi..."); filters now stack.
  4. **A favicon 404** logged a console error on every load.
  5. **Building the UI broke root linting**: ESLint's ignore pattern `dist/` only matched the repository root, so the built bundle was linted (1,117 errors). Found only because the build was run; fixed with `**/dist/`.
  6. A hypothesis was tested instead of assumed: two `ERR_ABORTED` console entries looked like a bug. They were React's dev-mode double mount; the production build, run through the same browser session, had none.
  7. Smaller slips: a test helper typed its mocks wrongly (the spread widened them), an abort test used `instanceof Error` which fails for jsdom's `DOMException` (the client now matches the abort by name, which also works across JavaScript realms), and one scripted edit did not apply because Prettier had re-wrapped the line; the real text was read first.
- **My decision:** Kept the labelled SAMPLE customer picker and the session-only booking list as they are. The real-browser run stays a documented manual check; no Playwright test.
- **Open decisions for the owner:** (a) keep the SAMPLE demo customer picker; (b) keep the session-only booking list; (c) the UI is not part of the backend's automated end-to-end suite, and the browser session (headless Chrome driven by a script kept outside the repository) was run by hand; is that acceptable, or should a small Playwright test be added?
- **Verified by:** 61 UI tests red first, then green; 14 deliberate UI bugs (14 caught, one needed its mutation redone because it had not applied, and it fails 26 tests); the whole flow run in a real browser against the real backend, in development and against the production build, at desktop and 390 px phone width, with screenshots in `docs/images/`; root lint, Prettier, typecheck and build clean.
