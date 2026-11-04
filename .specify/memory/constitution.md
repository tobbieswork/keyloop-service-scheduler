# Keyloop Service Scheduler Constitution

Reviewed and accepted by the owner on 2026-11-04.

## Core Principles

### I. Invariants Live in the Database
A bay or technician must never be double-booked. This is enforced by a Postgres
transaction plus an exclusion constraint on time ranges, not by application checks alone.

### II. Test-First (NON-NEGOTIABLE)
Tests for core business logic (availability, overlap, boundaries, skill match,
working hours, concurrency) are written and seen failing before implementation.
Key tests are proven by temporarily breaking the logic.

### III. Small Verified Slices
Work in small tasks. Each one is reviewed as a diff and committed separately,
so history shows design, tests, implementation and fixes.

### IV. Observable by Default
Structured logs with request IDs, metrics for booking outcomes and conflicts,
and tracing around the availability query.

### V. Secure and Honest
No secrets in code or logs. Validate all input. Errors use one consistent format
(409 Conflict for taken slots, with alternatives). Sample data is marked as sample.

### VI. Assumptions Are Documented
Ambiguous requirements get an explicit assumption in the spec, never a silent guess.

### VII. Simplicity
Prefer the simplest design that meets the acceptance criteria. Avoid speculative features.

## Stack Constraints
Node.js + TypeScript, PostgreSQL, REST (OpenAPI spec), Docker Compose for local setup.

## Governance
The owner has final say on every design decision. AI output is a draft until reviewed.
Meaningful AI interactions, including corrections, are recorded in AI_LOG.md.

**Version**: 1.0.0 | **Ratified**: 2026-11-04
