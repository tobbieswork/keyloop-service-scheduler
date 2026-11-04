# Quickstart: Validate the Service Scheduler

These commands were run against the finished backend. `docs/examples.sh` performs every scenario
below with real requests.

## Prerequisites
- Node.js 24 (`.nvmrc`), Docker running, `curl`, `jq`.

## Run
```bash
npm install
cp .env.example .env           # SAMPLE local settings
docker compose up -d db        # PostgreSQL 16
npm run migrate                # schema and constraints
npm run seed                   # SAMPLE data only (safe to run again)
npm run dev                    # http://localhost:3000
```

## Test
```bash
npm test                       # unit + integration (Testcontainers) + contract + performance
npm run test:unit              # fast, no Docker
npm run test:concurrency       # parallel bookings for the last slot (CONCURRENCY_ROUNDS=60 to stress)
npm run typecheck && npm run lint && npm run lint:api
```

## Validation scenarios (map to the spec)
Each is exercised by `bash docs/examples.sh` and by automated tests.

1. **Book (US1)**: `POST /appointments` with an `Idempotency-Key`. Expect `201` with bay and technician assigned.
2. **Same key again**: repeat the request. Expect `200`, the same appointment ID, header `Idempotent-Replayed: true`.
3. **Same key, different body**: expect `422 IDEMPOTENCY_KEY_REUSED`.
4. **Conflict (US1, US3)**: book the same slot until capacity runs out. Expect `409 SLOT_UNAVAILABLE` with up to 5 `alternatives` (the requested day first, then the next 7 days).
5. **Back-to-back (FR-005)**: book a slot starting exactly when another ends. Expect `201`.
6. **Availability (US2)**: `GET /availability`. Booked times disappear; the list agrees with what booking accepts.
7. **Concurrency (US3)**: `npm run test:concurrency`. Exactly one `201` for the last slot, all others `409`.
8. **Cancel (US4)**: `POST /appointments/{id}/cancel` (twice is fine), then book the same slot again. Expect `201`.
9. **Block (US5)**: `POST /technicians/{id}/unavailability`. Booking and availability then avoid that time; overlapping a confirmed appointment gives `409 RESOURCE_HAS_APPOINTMENTS`, overlapping another block gives `409 UNAVAILABILITY_OVERLAP`.
10. **Business rules**: outside working hours gives `422 OUTSIDE_WORKING_HOURS` (with the reason), a start in the past gives `422 START_IN_PAST`, malformed input gives `400 VALIDATION_ERROR`.
11. **Observability**: send `x-request-id: demo-1`, find `demo-1` in the logs and in the response header, and see the booking counters at `/metrics`.
