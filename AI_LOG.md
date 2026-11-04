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
- **My decision:** TBD
- **Verified by:** `npm ls` (no peer conflicts), `npm audit` (0 vulnerabilities), typecheck, lint and Prettier clean, a throwaway smoke test, and the compose database actually booted healthy on Postgres 16.15 and was torn down

### 2026-11-04: Config and database schema (T006-T011)

- **Phase:** implementation
- **Asked:** continue Phase 2 test-first: config, Kysely plumbing, Testcontainers helper, schema tests, migration
- **AI produced:** Zod config that lists every problem but never echoes values; typed Kysely layer; migration with the exclusion constraints; 15 config tests and 18 schema tests against a real Postgres 16
- **Problem / gap:** (1) Kysely 0.29 moved `Migrator` to `kysely/migration`; the compile error pointed straight at it. (2) The linter flagged a rethrown error with no `cause`, which would have hidden the original Postgres error. (3) The AI left a junk destructuring line in the schema test that did not compile, and removed it. (4) The migration added constraints (service duration > 0, weekday range, close after open, unavailability period checks) that were not in data-model.md; the doc was updated to match
- **My decision:** TBD
- **Verified by:** all tests were seen red first (config: module missing; schema: `relation "dealership" does not exist`), then green. Break-the-logic: removing the technician constraint, ignoring status in the bay constraint, and accepting inclusive bounds each failed exactly the intended tests (1, 2 and 1) and passed again once restored. A deliberate secret leak into the config error was caught by the no-leak test
