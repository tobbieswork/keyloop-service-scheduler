# Video script (target 8 minutes, limit 10)

<!-- DRAFT for the owner. Replace the [brackets] with your own words. Times are guides.
Keep the AI story to 1 to 2 minutes (the brief's limit) and tell it as 2 or 3 concrete moments. -->

## 0:00 to 0:45 Introduction

- [Name, role, one sentence about yourself.]
- Scenario A, the Unified Service Scheduler. In one sentence: _book a service appointment only when
  a bay and a qualified technician are both free for the whole service duration._
- I built the backend: REST API, PostgreSQL, OpenAPI contract, tests. Client side is cURL and the test suite.

## 0:45 to 3:15 System design (show `docs/system-design.md`, the architecture diagram)

- Layers: routes, services, pure domain logic, repositories, PostgreSQL. Pure domain means the
  rules (time ranges, working hours, daylight saving, slots) are tested without a database.
- **The hard problem is double-booking.** "Check, then insert" races. So correctness lives in the
  database: exclusion constraints on half-open time ranges (back-to-back is legal), plus row locks
  that never wait (`SKIP LOCKED`, no deadlocks), plus a re-check under the lock, plus a bounded retry.
- Idempotency key makes retries safe. Time zones and daylight saving are handled per dealership.
- Show the booking sequence diagram. Say what each layer protects against, and that I removed each
  layer on purpose to confirm a test fails (some are _masked_ by another layer, and I report that).
- Observability: request ID on every log line, no personal data in logs, Prometheus metrics with
  bounded labels, manual spans. Mention the honest limitation: automatic tracing does not work in ESM.

## 3:15 to 4:45 Demo (terminal, `bash docs/examples.sh`, or step through it)

1. Availability for a service. 2. Book: bay and technician are assigned for me.
2. Send the same request again: 200, same appointment. 4. Fill the capacity: 409 with alternatives.
3. Cancel, then book the same slot. 6. Block a technician: booking and availability avoid that time.
4. Show `/metrics` and a log line with the request ID.

- Optional, 20 seconds: run `npm run test:concurrency` and point at "20 requests, exactly one booking".

## 4:45 to 6:30 AI collaboration story (1 to 2 minutes of this is the required part)

Pick two or three. Facts are in `AI_LOG.md`.

- **I directed, the AI drafted.** Spec first with Spec Kit. I answered the clarifying questions and
  overrode one of the AI's recommendations (per-resource unavailability, accepting more schema and tests).
- **The flakiness check caught a real bug.** I ran the concurrency suite 20 times; one run gave
  5 confirmed and 25 rejected with a place free. It was not reproducible on demand, so we reasoned
  from the code: a fixed retry count cannot be right because a slow request can lose three races.
  The fix was a time budget; 20 of 20 clean afterwards. Show the diff or the log entry.
- **Running it for real found what 439 tests missed.** Cancelling returned 400 from a real client
  because the integration tests never sent a JSON content type with no body.
- **The AI was wrong, and tests said so.** [One example in your own words: the false comment about
  Node's JSON errors, or the `FOR UPDATE` deadlock.]

## 6:30 to 7:30 What I learned and what was hard

- [Your words.] Suggested threads: a test that never failed proves little; layered protections hide
  each other, so you must break them in combination; asking the AI to _try to break its own work_
  was more useful than asking it to write more tests.
- Challenges: [e.g. making races deterministic; daylight saving; knowing when a passing run was not real evidence.]

## 7:30 to 8:00 Close

- Limitations, honestly: no auth, no holidays, a 409 is possible if resources stay locked for a full
  second, alternatives are earliest not nearest. What I would do next: auth, customer search, automatic tracing.
- Thank you.
