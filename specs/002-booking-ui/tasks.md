# Tasks: Booking UI

Tests first, as for the backend. Everything lives in `frontend/`, self-contained.

- [x] U01 Scaffold `frontend/`: Vite, React, TypeScript, Vitest, Testing Library, proxy `/api` to the backend, exact-pinned dependencies
- [x] U02 Write failing unit tests `frontend/src/time.test.ts`: format a UTC instant in the dealership zone (including a daylight-saving day), "tomorrow in that zone", date parts
- [x] U03 Implement `frontend/src/time.ts`
- [ ] U04 Write failing tests `frontend/src/api.test.ts`: URLs, headers (Idempotency-Key), success shapes, API error to `ApiError` with request ID, network failure to `NetworkError`, 409 alternatives
- [ ] U05 Implement `frontend/src/api.ts` (typed client, no UI)
- [ ] U06 Write failing component tests `frontend/src/App.test.tsx` with a fake backend: load and defaults, availability list in local time, empty state, book, same key on retry after a network failure, 409 with alternatives and booking one, cancel, error messages with request ID, loading and disabled states
- [ ] U07 Implement `App.tsx` and components (picker, slot list, confirm panel, session list, notices) and styles
- [ ] U08 Add accessibility checks to the tests (labels, roles, live region) and fix what they find
- [ ] U09 Run the UI against the real backend, fix what the hands-on run finds, take a screenshot at desktop and phone width
- [ ] U10 Document: `frontend/README.md`, root README section, system-design note, AI log entry
