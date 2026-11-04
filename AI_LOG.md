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
- **My decision:** TBD (owner to review the constitution, spec and assumptions)
- **Verified by:** TBD

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
- **My decision:** TBD (owner to review and accept or change each extra choice)
- **Verified by:** TBD. Only the OpenAPI YAML was parse-checked; the SQL in data-model.md has not been run yet
