# Keyloop Service Scheduler

Keyloop technical assessment, **Scenario A: The Unified Service Scheduler**. A backend that books a
service appointment only when **a service bay and a qualified technician are both free for the whole
service duration**, and stores an appointment linking customer, vehicle, technician and bay.

- **Layers implemented:** the backend in depth (REST API, PostgreSQL, OpenAPI contract), plus a small
  [booking UI](frontend/README.md). cURL examples are in `docs/examples.sh`.
- **Stack:** Node.js 24, TypeScript (strict), Fastify, Zod, Kysely, PostgreSQL 16, Vitest, Testcontainers.
- **Documents:** [System Design Document](docs/system-design.md) ·
  [API contract](specs/001-service-scheduler/contracts/openapi.yaml) ·
  [Spec trail](specs/001-service-scheduler/) · [AI log](AI_LOG.md) · [Video script](docs/video-script.md)

## What it does

|                        | Endpoint                                                                  | Notes                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Book                   | `POST /appointments`                                                      | The **system** assigns bay and technician. Needs an `Idempotency-Key` header. `201` created, `200` replay, `409` no capacity (with up to 5 alternative slots), `422` business rule, `404`, `400`. |
| Availability           | `GET /availability?dealershipId&serviceTypeId&date`                       | Every bookable 15-minute start on that local date. Uses the same rules as booking.                                                                                                                |
| Read                   | `GET /appointments/{id}`                                                  | Includes cancelled ones.                                                                                                                                                                          |
| Cancel                 | `POST /appointments/{id}/cancel`                                          | Idempotent. The record is kept and the place is freed.                                                                                                                                            |
| Block                  | `POST /bays/{id}/unavailability`, `POST /technicians/{id}/unavailability` | Maintenance, leave, off shift. Refused if it would overlap a confirmed appointment (`409`) or another block (`409`).                                                                              |
| List and remove blocks | `GET` the same URLs; `DELETE .../unavailability/{blockId}`                | Earliest first; `204` on removal; a block cannot be removed through the wrong resource or kind.                                                                                                   |
| Reference              | `GET /dealerships`, `GET /service-types`                                  |                                                                                                                                                                                                   |
| Operations             | `GET /health`, `GET /ready`, `GET /metrics`                               | Liveness, readiness (checks the database), Prometheus.                                                                                                                                            |

## Build, run and test

**Prerequisites:** Node.js 24 (see `.nvmrc`), Docker running (the database, and the integration tests
start real PostgreSQL containers), `curl` and `jq` for the examples.

```bash
npm install
cp .env.example .env              # SAMPLE local settings, no real secrets
docker compose up -d db           # PostgreSQL 16
npm run migrate                   # schema and constraints
npm run seed                      # SAMPLE data only (safe to run again)
npm run dev                       # http://localhost:3000
```

Try it (needs the server running):

```bash
bash docs/examples.sh             # every scenario with real requests; safe to re-run
curl -s localhost:3000/health
```

Run the tests:

```bash
npm test                          # everything: unit + integration + contract (about 1 minute)
npm run test:unit                 # fast, no Docker
npm run test:concurrency          # the race tests; CONCURRENCY_ROUNDS=60 for a stress run
npm run typecheck && npm run lint && npm run lint:api   # types, code style, OpenAPI contract
npm run build && npm start        # the compiled server
```

All data in the repository is marked `SAMPLE`. Configuration is read from the environment and
validated at start-up; errors name the variable but never print its value.

## How it stays correct

Double-booking is prevented in the database, not just in code. Four layers, each tested (details in
[`docs/system-design.md`](docs/system-design.md#5-correctness-under-concurrency-the-core-design-decision)):

1. **Exclusion constraints** on bay and technician time ranges (half-open, so back-to-back is fine).
2. **Row locks** (`FOR NO KEY UPDATE SKIP LOCKED`): bookings never wait on each other, so no deadlocks.
3. **Re-check under the lock**, covering blocks that commit in between.
4. **Retry policy**: contention is retried until capacity is gone or a 1 second budget ends.

Retries are safe because every booking carries an idempotency key. Working hours, the 15-minute
grid and "which day" are computed in the **dealership's time zone**, including daylight saving.

## Booking UI

A deliberately simple React front end in [`frontend/`](frontend/README.md): choose a dealership, service
and date, see the times in the **dealership's own clock**, book, recover from a conflict, cancel.

```bash
cd frontend && npm install && npm run dev      # http://localhost:5173 (backend must be running)
npm run test:ui                                # 61 tests, from the repository root
```

| Times and booking                  | After a conflict                         | On a phone                         |
| ---------------------------------- | ---------------------------------------- | ---------------------------------- |
| ![times](docs/images/ui-times.png) | ![conflict](docs/images/ui-conflict.png) | ![phone](docs/images/ui-phone.png) |

Its limits are stated on screen: customers are a SAMPLE-data demo picker (the API has no
customer-listing endpoint, on purpose) and the list of bookings covers the current session only.

## Project layout

```text
src/domain/        pure rules: time ranges, working hours, slots, resource ranking (no I/O)
src/services/      use cases and transaction boundaries (booking, availability, cancel, blocks)
src/db/            migrations, typed queries, SAMPLE seed
src/api/           routes, validation, the single error shape
src/observability/ request IDs, PII-safe logs, metrics, spans
tests/             unit, integration (real PostgreSQL), contract (OpenAPI), performance
specs/             constitution, spec, clarifications, plan, research, data model, contract, tasks
frontend/          the booking UI (React, Vite), with its own tests and README
docs/              system design, cURL examples, video script
```

## Results

- **Tests:** 523 passing: 462 backend (198 unit, the rest integration, contract, concurrency and
  performance) and 61 frontend.
- **Performance** at 50 concurrent requests on a laptop, against targets set in the plan: booking
  p95 **125 ms** (target 300 ms); availability p95 **31 ms** (target 200 ms).
- **Concurrency:** 20 parallel requests for the last slot give exactly one booking; 30 requests for
  6 places give exactly 6. The suite was run 20 times in a row after the final fix (20 of 20 clean).

## Assumptions and limitations

Assumptions (all in the spec): the system assigns bay and technician; the buffer is per service type
and added to the duration; bays and technicians can be blocked; slots start on 15-minute boundaries;
the whole occupied period must fit inside one day's working hours; cancelling is allowed at any time.

Limitations, stated plainly: no authentication or rate limiting; no dealership holidays; a block over
an existing appointment is refused rather than cancelling it; alternatives are the _earliest_ free slots,
not the nearest to the requested time; tracing is manual
spans only (automatic HTTP and database spans need an ESM loader hook, see the design document).

## AI Collaboration Narrative

I used Claude Code throughout. I made the product and design decisions; the AI researched, drafted,
built and tested. I treated everything it produced as a draft until I had seen it fail and then pass.

### How I guided the AI

- **I set the scope.** Scenario A, the backend first, and a simple frontend afterwards.
- **I asked how to work before we started.** Before any code I asked the AI to explain what the
  assessment is really testing (how I use AI and how I manage it), so I would know what to show. Then
  I asked whether I could use spec-driven development and which framework to use. We used GitHub Spec
  Kit: constitution, spec, clarify, plan, tasks, analyze, and only then code.
- **The decisions were mine.** The AI asked clarifying questions and recommended answers; I made the
  calls that shaped the product:
  - I **overrode its recommendation** to keep resource availability simple, and chose per-resource
    unavailability (maintenance, leave, shifts) and accepted the extra work. Real dealerships
    have bays under maintenance and technicians on leave, so treating every resource as always free
    would book work nobody can do.
  - I chose to **start a fresh repository** instead of continuing an older half-built one.
  - I set the **alternatives rule**: when a time is taken, offer up to 5 other slots, the requested day
    first and then the next 7 days. A customer who cannot get their time should be offered
    something useful, not a dead end.
  - I asked for the missing **user story for blocking resources** to be added to the spec instead of
    leaving a requirement with no story, and later asked for **list and remove** for those blocks.
  - I kept the **SAMPLE customer picker** in the UI rather than expose customers through the API.
    Customer names and contacts are personal data, and the service has no authentication yet.
- **I let it work in long stretches and saved my decisions for later.** When I needed a break I told it
  to keep going and to collect the questions that needed me. Each one waited as a `TBD` in `AI_LOG.md`
  until I answered them all in one round.
- **Small slices, tests first.** The history shows a failing-test commit and then the commit that makes
  it pass. The exceptions are in the log.

### How I checked its work

- **I did not accept "not yet verified".** I asked the AI to re-verify those items. It ran the
  data-model SQL on a real PostgreSQL, linted the API contract, and later ran the real service.
- **I read and answered the decision prompts** (what changed, what is the trade-off) instead of
  approving everything.
- **I ran the app myself, and it did not start.** `npm run dev` failed for me. I did not paste the error,
  so the AI reproduced it: it had put that command in the instructions without ever running it.
- **The AI had to try to break its own work.** About 95 deliberate bugs were introduced to prove the
  tests can fail. Where one survived, either another safety layer was hiding it (recorded honestly) or
  the test was too weak (and was fixed).
- **Rare races were reproduced on purpose**, and the race tests were run 20 times in a row to check
  they are not flaky.
- **`/speckit-analyze` found 14 inconsistencies** before any implementation, including a success
  criterion that contradicted a planned test.

### Mistakes caught (the useful part)

| What went wrong                                                                                                               | How it was caught                                                                         | Outcome                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `FOR UPDATE` row locks made a test deadlock                                                                                   | A hung test run                                                                           | Diagnosed as a conflict with foreign-key locks; now `FOR NO KEY UPDATE`, with a regression test |
| A request with the same idempotency key could get a false 409                                                                 | Predicted from the code, then reproduced deterministically with a test seam               | Re-read the key before ever answering 409                                                       |
| One run in 20 gave a false "no capacity" (5 confirmed, 25 rejected, a place free)                                             | The 20-run flakiness loop                                                                 | Fixed retry count replaced by a time budget; 20 of 20 clean afterwards                          |
| Cancelling returned 400 from real clients                                                                                     | The hands-on cURL run (every integration test missed it)                                  | Empty JSON bodies accepted; the JSON parser left untouched                                      |
| Ordinary 409s were recorded as tracing errors; automatic tracing produced nothing                                             | Reading what the running server actually emitted                                          | Expected rejections no longer errors; dead instrumentation removed and documented               |
| Tests blocked a resource nobody would have chosen, so a bug survived                                                          | A deliberate break survived                                                               | Tests now block the resource that would be picked first                                         |
| The UI's list of times vanished on every refresh, the confirmation stayed open after a conflict, phone dropdowns were cut off | A run in a real browser against the real API (58 UI tests with a fake backend had passed) | Fixed test-first; run again in a browser                                                        |
| **`npm run dev` did not start**                                                                                               | **I ran it myself**                                                                       | Script order fixed; a deprecation warning removed; a test now fails on any such warning         |

The smaller slips, including the AI's own test-harness bugs and a script that overwrote its own files, are
all recorded in `AI_LOG.md`.

### The booking UI

After the backend I asked for a simple frontend. It followed the same method: a short spec, tests first
against a fake backend, then a run in a real browser against the real API. That run found four problems
the tests could not see. The UI states its two limits on screen: customers come from a SAMPLE demo
picker (the API deliberately has no customer-listing endpoint), and the booking list covers one session.

### What I learned

I learned a lot about how a car-service business really runs, with real cases I had not thought about
before.

- A booking needs **two things at once**: a free bay and a technician with the right skill.
- **Cleanup time** between jobs takes capacity even though the customer never sees it.
- "09:00" means the **dealership's local time**, including daylight saving, not the customer's.
- People click twice and networks retry, so a booking has to be **safe to repeat**.
- When two customers want the last slot, exactly one must win, and the other should be **offered
  alternatives**, not an error.
- Staff leave and bay maintenance **reduce capacity**, and a cancellation should give the place back.

About working with AI: it is fast, but it states wrong things with confidence, so I do not trust a
result until I have seen the check fail.

### What I would do differently, and where I am less sure

Because I let the AI work for long stretches, my checking was mostly on behaviour, tests and
logs, not line by line through the generated code. Next time I would read the key parts, such as the
booking transaction, with it before moving on. The product limits are listed under "Assumptions and
limitations" above.

### Quality

523 tests (462 backend, 61 frontend), strict TypeScript, ESLint, Prettier, a linted OpenAPI contract,
measured performance, and a log (`AI_LOG.md`) of every meaningful AI interaction, including what the AI
got wrong.
