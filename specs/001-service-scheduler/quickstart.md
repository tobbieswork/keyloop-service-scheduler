# Quickstart: Validate the Service Scheduler

Target commands for the finished backend. They are provisional until implementation (tasks.md) is complete.

## Prerequisites
- Node.js 24 (`.nvmrc`), Docker running (OrbStack daemon must be started), `curl`, `jq`.

## Run
```bash
npm install
docker compose up -d db        # Postgres 16
npm run migrate                # schema, constraints
npm run seed                   # SAMPLE data only
npm run dev                    # http://localhost:3000
```

## Test
```bash
npm test                       # unit + integration (Testcontainers) + contract
npm run test:concurrency       # parallel bookings for the last slot
```

## Validation scenarios (map to the spec)
1. **Book (US1)**: POST `/appointments` with an `Idempotency-Key`. Expect 201 with bay and technician assigned.
2. **Same key again**: repeat the same request. Expect 200, same appointment ID, header `Idempotent-Replayed: true`.
3. **Conflict (US1)**: book the same slot until capacity runs out. Expect 409 `SLOT_UNAVAILABLE` with `alternatives`.
4. **Back-to-back (FR-005)**: book a slot starting exactly when another ends. Expect 201.
5. **Availability (US2)**: GET `/availability`. Booked times disappear from the list.
6. **Concurrency (US3)**: `npm run test:concurrency`. Exactly one 201, all others 409.
7. **Cancel (US4)**: POST `/appointments/{id}/cancel`, then book the same slot again. Expect 201.
8. **Unavailability (FR-015)**: mark the only bay unavailable, then book over it. Expect 409.
9. **Observability**: send `x-request-id: demo-1`, find `demo-1` in the logs, and see the booking counters at `/metrics`.

Full cURL examples will be added to `docs/examples.sh` during implementation.
