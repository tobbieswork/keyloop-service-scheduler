# Implementation Plan: Unified Service Scheduler

**Branch**: `001-service-scheduler` (spec directory only) | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-service-scheduler/spec.md`

## Summary

A REST backend that books a service appointment only when a service bay and a qualified technician are both free for the whole occupied period (service duration plus per-type buffer). The system auto-assigns resources (least-booked that day, ties by lowest ID). Double-booking is prevented in PostgreSQL with a transaction plus exclusion constraints on half-open time ranges, with row locks to cover resource unavailability and a bounded retry on conflict. Retried requests are made safe by an idempotency key. The implementation target is the backend; a thin frontend may follow in a separate spec.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 LTS (matches the local fnm install)

**Primary Dependencies**: Fastify (HTTP), Zod via `fastify-type-provider-zod` (validation and OpenAPI), Kysely + `pg` (typed SQL), pino (logs), `prom-client` (metrics), OpenTelemetry SDK (tracing). Exact versions pinned at install time.

**Storage**: PostgreSQL 16 with the `btree_gist` extension (needed for exclusion constraints that mix equality and range overlap)

**Testing**: Vitest. Unit tests for pure domain logic; integration tests against a real Postgres (Testcontainers) including a concurrency test. No database mocks for booking logic.

**Target Platform**: Linux container (Docker Compose for local run); developed on macOS

**Project Type**: web-service (backend only for this spec)

**Performance Goals**: booking p95 under 300 ms and availability p95 under 200 ms at 50 concurrent requests on a laptop-class machine (supports SC-002's 1 s ceiling)

**Constraints**: zero double-booking under concurrency (SC-001); no secrets in code or logs; no personal data in logs

**Scale/Scope**: tens of dealerships, about 10 bays and 20 technicians each, tens of thousands of appointments. Single database node.

## Constitution Check

*GATE: pass before Phase 0 research; re-checked after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Invariants live in the database | Pass | Exclusion constraints on bay and technician time ranges; row locks plus a transactional check for unavailability periods |
| II. Test-first | Pass | Tasks order tests before implementation; concurrency test is a P1 deliverable |
| III. Small verified slices | Pass | Tasks are per-layer and independently committable |
| IV. Observable by default | Pass | Request IDs, structured logs, booking/conflict metrics, traced availability query |
| V. Secure and honest | Pass | Zod validation, uniform error format, sample data flagged, no auth (documented out of scope) |
| VI. Assumptions documented | Pass | See Assumptions in the spec and Decisions in research.md |
| VII. Simplicity | Pass | Single service, single database, no queue or cache |

No violations; Complexity Tracking is not needed.

**Post-design re-check**: Pass. One note: the unavailability-vs-booking race needs row locks in addition to the exclusion constraint (see research.md decision 2). The constitution says invariants live in the database. Row locks are also in the database, so this still complies.

## Project Structure

### Documentation (this feature)

```text
specs/001-service-scheduler/
├── plan.md              # This file
├── research.md          # Phase 0: decisions with alternatives
├── data-model.md        # Phase 1: schema, constraints, state
├── quickstart.md        # Phase 1: run and validate guide
├── contracts/
│   └── openapi.yaml     # Phase 1: REST contract
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── domain/            # Pure logic: time ranges, slot generation, resource selection. No I/O.
├── db/                # Kysely instance, migrations (SQL), seed data (marked sample), repositories
├── services/          # Booking, availability, cancellation, unavailability use cases (transactions live here)
├── api/               # Fastify routes, Zod schemas, error mapping
├── observability/     # Logger, request ID, metrics, tracing setup
├── config.ts          # Environment-based config, validated at startup
└── server.ts          # Wiring and startup

tests/
├── unit/              # domain/ (fast, no database)
├── integration/       # services + API against real Postgres, incl. concurrency
└── contract/          # responses validated against contracts/openapi.yaml

docker-compose.yml     # Postgres for local run
```

**Structure Decision**: Single project (backend only). The domain layer is pure so the core rules (overlap, boundaries, working hours, selection) are unit-testable without a database. The services layer owns transaction boundaries, so HTTP and persistence stay decoupled.

## Complexity Tracking

No constitution violations to justify.
