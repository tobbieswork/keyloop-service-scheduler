# Video script (target 8 minutes, limit 10)

_Tip: say only what you could explain if asked, and change any line to sound like you._

## 0:00 to 0:45 Introduction

Say something like:

- "Hi, I'm Dang Phat Nguyen, most people call me Tobbies. I'm a software engineer at FPT Corporation."
- "My day job is a data platform: how large companies explore, manage, pipeline and store their data.
  On the side I'm building a project that manages AI agents to automate workflows, so working with AI agents is familiar to me. It's called opencode-telegram-bot and it's on my GitHub."
- "I'm very interested in Keyloop and in how Keyloop applies AI in its work, so an assignment where AI
  is a required collaborator was a great fit."
- "I chose Scenario A, the service scheduler. In one sentence: it books a car-service appointment only
  when a service bay and a qualified technician are both free for the whole service."
- "I built the backend in depth (API, PostgreSQL, tests) and a simple frontend on top."

## 0:45 to 3:00 System design (show `docs/system-design.md`, the architecture diagram)

- Layers: routes, services, pure domain logic, repositories, PostgreSQL. The pure domain layer means
  the rules (time ranges, working hours, daylight saving, slots) are tested without a database.
- **The hard problem is double-booking.** "Check, then insert" races. So correctness lives in the
  database: exclusion constraints on time ranges (back-to-back bookings are fine), row locks that
  never wait, a re-check under the lock, and a bounded retry.
- A booking key makes retries safe. Time zones and daylight saving are handled per dealership.
- Show the booking sequence diagram. Be honest that each layer is tested by removing it on purpose,
  and that some are _masked_ by another layer, which the tests report rather than hide.
- Observability in one breath: a request ID on every log line, no personal data in logs, Prometheus
  metrics, manual trace spans. Mention the honest limitation: automatic tracing needs a loader hook.

## 3:00 to 5:00 Demo

1. **UI** (`http://localhost:5173`): pick a dealership, a service and a date. Point out that times are
   shown in the **dealership's clock**, with the zone. Book a time, see it confirmed, cancel it.
2. **Terminal**: `bash docs/examples.sh`. Pause on the **409 with alternatives**, then the **block**
   (create, list, remove).
3. **Tests**: `npm run test:concurrency` and point at "20 requests, exactly one booking".

## 5:00 to 6:45 AI collaboration story (1 to 2 minutes is the required part)

Tell it as three moments you can show on screen. Facts are in `AI_LOG.md`.

**A. I overrode the AI (about 35 seconds).** Say something like: "When we clarified the requirements,
the AI recommended keeping it simple: every bay and technician is available whenever the dealership
is open. I chose per-resource unavailability instead, because real dealerships have bays under maintenance and technicians on leave. That meant a whole extra user story, and the hardest
tests in the project, and I think it was worth it because it made the scheduler realistic: without it, it would ignore staff leave and bay maintenance, and it led to the strongest race tests." Show the clarify answer in the
spec and the blocking tests.

**B. The test that deadlocked (about 35 seconds).** Say something like: "A test hung forever. The AI
diagnosed it: booking locked the chosen bay, and the database's foreign-key check needs a lock that
clashes with that one, so an unrelated write could have got stuck behind a booking in production. The
fix was one word, plus a regression test that now fails in two seconds instead of hanging." Show the
diff of `FOR UPDATE` to `FOR NO KEY UPDATE` and the log entry.

**C. Running it for real found what the tests missed (about 40 seconds).** Say something like: "The
suite was green, but when we ran the real service, cancelling failed from real clients because they send
a JSON content type with an empty body, which our tests never did. In the UI, the list of times
vanished on every refresh. And when I ran `npm run dev` myself, it didn't start, and the AI had never
run it. Passing tests are not the same as it working, so I checked it myself." Show the cancel fix, the
before and after of the list, and the dev-server entry in the log.

## 6:45 to 7:45 What I learned and what was hard

Say something like:

- "I learned a lot about how a car-service business really runs, with real cases I had not thought
  about: a booking needs a free bay _and_ a technician with the right skill; cleanup time between jobs
  takes capacity; '9 o'clock' means the dealership's clock, including daylight saving; people click
  twice and networks retry; two customers can want the last slot; staff leave and bay maintenance
  reduce capacity."
- "About AI: it is fast, but it states wrong things with confidence, so I do not trust a result until I have seen the check fail."
- "The hardest part was trusting AI that works unattended. I let it run in long stretches, so I had to check its output afterwards instead of watching it write."

## 7:45 to 8:15 Close

- Limitations, honestly: no authentication or rate limiting, no dealership holidays, a booking can be
  refused if resources stay locked for a full second, alternatives are the earliest slots rather than
  the nearest.
- Next: authentication, customer search, automatic tracing.
- "Thank you. I would really like to hear how Keyloop is applying AI in practice."
