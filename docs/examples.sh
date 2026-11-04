#!/usr/bin/env bash
# cURL walk-through of every scenario in specs/001-service-scheduler/quickstart.md.
#
#   docker compose up -d db && npm run migrate && npm run seed && npm run dev   # in another terminal
#   bash docs/examples.sh
#
# Needs: curl, jq, node. Uses the SAMPLE data from `npm run seed` (fixed IDs). Safe to run again:
# every run uses a fresh Idempotency-Key prefix and the first weekday that still has room.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN="run$(date +%s)"                       # makes idempotency keys unique per run

# SAMPLE IDs from src/db/seed.ts
LONDON=00000001-0000-4000-8000-000000000001
BRAKES=00000003-0000-4000-8000-000000000002   # 90 min + 15 min buffer, needs the "brakes" skill
CUSTOMER=00000004-0000-4000-8000-000000000001
VEHICLE=00000005-0000-4000-8000-000000000001
LONDON_TECH_1=00000007-0000-4000-8000-000000000001

# Find a weekday, about two weeks ahead, that still has plenty of free brake-service slots, so the
# walk-through works on a fresh database and again on a busy one (including a second run).
find_day() {
  local start="$1" i day count
  for i in $(seq 0 40); do
    day=$(node -e "const d = new Date('${start}T00:00:00Z'); d.setUTCDate(d.getUTCDate() + ${i});
      if ([0, 6].includes(d.getUTCDay())) process.exit(3); console.log(d.toISOString().slice(0, 10));") || continue
    count=$(curl -sS "$BASE_URL/availability?dealershipId=$LONDON&serviceTypeId=$BRAKES&date=$day" | jq '.slots | length')
    if [ "$count" -ge 25 ]; then echo "$day"; return 0; fi
  done
  echo "no weekday with enough free slots in the next 40 days" >&2
  return 1
}
DAY="${DAY:-$(find_day "$(node -e 'const d = new Date(); d.setUTCDate(d.getUTCDate() + 14); console.log(d.toISOString().slice(0, 10))')")}"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# call METHOD PATH [JSON_BODY] [extra curl args...]: print the request, the HTTP status and the body.
call() {
  local method="$1" path="$2" body="${3:-}"; shift 3 || shift $#
  printf '  %s %s\n' "$method" "$path"
  local out; out=$(curl -sS -X "$method" "$BASE_URL$path" -H 'content-type: application/json' \
    ${body:+--data "$body"} -w '\n%{http_code}' "$@")
  printf '  -> HTTP %s\n' "${out##*$'\n'}"
  LAST_BODY="${out%$'\n'*}"
  echo "$LAST_BODY" | jq -C . 2>/dev/null | sed 's/^/     /' || echo "     $LAST_BODY"
}
book() { # book START KEY
  call POST /appointments "$(jq -nc --arg s "$1" --arg c "$CUSTOMER" --arg v "$VEHICLE" --arg st "$BRAKES" --arg d "$LONDON" \
    '{customerId:$c,vehicleId:$v,serviceTypeId:$st,dealershipId:$d,startTime:$s}')" -H "Idempotency-Key: $2"
}

step "Health, readiness and the dealerships and service types the data holds"
call GET /health "" ; call GET /ready ""; call GET /dealerships ""; call GET /service-types ""

step "Availability (US2): bookable start times for a brake service on $DAY"
call GET "/availability?dealershipId=$LONDON&serviceTypeId=$BRAKES&date=$DAY" ""
SLOTS=$(echo "$LAST_BODY" | jq -r '.slots[].startTime')
FIRST=$(echo "$SLOTS" | sed -n 1p); SECOND_FREE=$(echo "$SLOTS" | sed -n 10p); LATE=$(echo "$SLOTS" | tail -n 6 | sed -n 1p)

step "Book (US1): the system picks the bay and technician"
book "$FIRST" "$RUN-1"; APPT=$(echo "$LAST_BODY" | jq -r .id)

step "Same Idempotency-Key again: 200 and the SAME appointment (a safe retry)"
book "$FIRST" "$RUN-1"

step "Same key, different request: 422 IDEMPOTENCY_KEY_REUSED"
book "$SECOND_FREE" "$RUN-1"

step "Fill the capacity at the same time: two technicians hold the brakes skill, so the third booking conflicts"
book "$FIRST" "$RUN-2"
book "$FIRST" "$RUN-3"   # 409 SLOT_UNAVAILABLE with up to 5 alternatives (US3)

step "Business rules: outside working hours (422) and a malformed request (400)"
book "${DAY}T03:00:00.000Z" "$RUN-4"
call POST /appointments '{"customerId":"nope"}' -H "Idempotency-Key: $RUN-5"

step "Retrieve, then cancel (US4); cancelling twice is safe"
call GET "/appointments/$APPT" ""
call POST "/appointments/$APPT/cancel" ""
call POST "/appointments/$APPT/cancel" ""

step "The cancelled place is free again: book the same slot"
book "$FIRST" "$RUN-6"
REBOOKED_TECH=$(echo "$LAST_BODY" | jq -r .technicianId)

step "Block a technician for two hours later in the day (US5)"
END=$(node -e "console.log(new Date(Date.parse('$LATE') + 2 * 3600e3).toISOString())")
BLOCK=$(jq -nc --arg s "$LATE" --arg e "$END" '{startTime:$s,endTime:$e,reason:"SAMPLE: training course"}')
call POST "/technicians/$LONDON_TECH_1/unavailability" "$BLOCK"
step "List the technician's blocks, then remove the one just created (it frees the time again)"
call GET "/technicians/$LONDON_TECH_1/unavailability" ""
BLOCK_ID=$(echo "$LAST_BODY" | jq -r --arg s "$LATE" 'map(select(.startTime == $s)) | .[0].id')
call DELETE "/technicians/$LONDON_TECH_1/unavailability/$BLOCK_ID" ""
step "Block it again, then try to overlap it: 409 UNAVAILABILITY_OVERLAP"
call POST "/technicians/$LONDON_TECH_1/unavailability" "$BLOCK"
call POST "/technicians/$LONDON_TECH_1/unavailability" "$BLOCK"
step "Blocking over a confirmed appointment: 409 RESOURCE_HAS_APPOINTMENTS"
OVER=$(jq -nc --arg s "$FIRST" --arg e "$(node -e "console.log(new Date(Date.parse('$FIRST') + 3600e3).toISOString())")" '{startTime:$s,endTime:$e,reason:"SAMPLE"}')
call POST "/technicians/$REBOOKED_TECH/unavailability" "$OVER"

step "Observability: a request ID you choose comes back, and the booking counters are exposed"
curl -sS -i -H 'x-request-id: demo-1' "$BASE_URL/health" | sed -n '1p;/x-request-id/Ip'
curl -sS "$BASE_URL/metrics" | grep -E '^scheduler_booking_(outcomes_total|retries_total)' | sed 's/^/     /'
echo
