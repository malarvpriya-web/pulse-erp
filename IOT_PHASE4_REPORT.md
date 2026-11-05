# Phase 4 — Industrial IoT, Equipment Monitoring & Service Integration

**Date:** 2026-09-14, gap closure 2026-09-15, independent re-verification 2026-09-15
**Scope:** `backend/src/modules/iot`, `backend/src/jobs/iot*`, `edge-gateway`,
`frontend/src/features/iot`, `backend/src/modules/intelligence/ai.routes.js` (the
device-risk endpoints), four migrations.

---

# M. CERTIFICATION

# NOT CERTIFIED — ONE REMAINING ITEM, AND IT IS NOT SOFTWARE

Every P0 and P1 security and telemetry-integrity issue is closed and proven by
test. All twelve of the gaps this report originally listed are now either closed
or reduced to the single physical dependency below.

**Re-verified on 2026-09-15 by a pass that set out to disprove this report**
rather than extend it. Every claim it checked held, and all the numbers below were
re-run rather than carried forward: 132 backend IoT tests, 40 gateway tests, 33
Playwright cases in a real browser, and a full backend suite of 1,515 passing with
nothing failing. That pass did find **one defect these two passes had missed** —
the device-facing ingest routes had no rate limit at all for unauthenticated
callers, because an exclusion meant to protect multi-gateway sites was
unconditional. It is fixed, reproduced before and after against a running server,
and covered by tests (section K, "the backstop did not exist"). It does not change
the verdict: it is an availability defect, not a tenancy or telemetry-integrity
one.

**No hardware pilot has been performed.** No AHF, SVG or STATCOM has been
connected to this gateway. §60 and §75.17 make this a condition of certification,
and correctly so: a wrong word order or addressing mode produces a finite,
plausible, wrong number — reported as quality `VALID`, because nothing in the
protocol says it is wrong. One of the Modbus integration tests asserts exactly
that, so the claim is demonstrated rather than asserted.

**What changed on 2026-09-15 is the size of the remaining unknown.** It was
*"the whole Modbus path is unexercised"* — `modbus-serial` was an optional
dependency that had never been installed, so `createSource()` had never executed
at all, and every line of connect / read / partial-failure / reconnect was
unverified code in a file whose header described it as production-ready. It is
now *"the register map for this model is unverified"*:

| Was | Is |
| --- | --- |
| Modbus client path never executed | 12 tests against a real Modbus TCP server |
| Register map entered by hand-written SQL | Validated editor in the UI |
| Conventions established by trial and error | One tool reads once, decodes all four side by side |
| Pilot result lived in a markdown form | Recorded in `iot_hardware_pilots`, un-fakeable by three layers |

Certification is withheld on that one item alone. Certifying without it would
mean asserting that a particular device is read correctly on the strength of a
server that answers whatever the test asked it to.

---

# A. Executive summary

The audit's conclusion — a useful monitoring foundation, not a reliable industrial
IoT module — was accurate. The specific defects were worse than "incomplete": most
of them produced **confident, wrong output** rather than visible failure.

The eight that mattered most:

| # | Defect | What it actually did |
| --- | --- | --- |
| 1 | **Tenant scope failed open** | `req.scope?.company_id ?? null` followed by `if (companyId != null) add the predicate`. `verifyToken` sets `req.scope = null` for any authenticated non-super-admin with no `user_scope` row. Those users received **every company's** devices, telemetry, alerts and rules, and could provision or rotate credentials on another tenant's hardware. |
| 2 | **Ticket creation inside the ingest transaction** | A comment promised "never throws — a ticket failure must not roll back the telemetry write". Postgres does not work that way: a raising statement aborts the transaction, so a ticket failure took the whole telemetry batch with it, and the handler's catch then ran more SQL on an aborted transaction. |
| 3 | **No retry identity** | Sample identity was `(BIGSERIAL id, ts)`. A gateway that committed a batch and lost the HTTP response resent it and got a **second copy of every reading**. |
| 4 | **Event time doubled as liveness** | A sample stamped 2099 set `last_seen_at` and `connection_state = 'online'`. A dead device could read as healthy indefinitely. |
| 5 | **Only the last sample of a batch was evaluated** | 10:00 = 100, 10:01 = 180, 10:02 = 105 against a threshold of 150 raised **nothing**. On a 60-second poll with a five-minute flush that is four unexamined samples per batch. |
| 6 | **Overlapping gateway flushes** | `flush()` was re-entrant on a `setInterval`, and removal was by COUNT. Under a slow network — exactly when it matters — the same samples were sent twice AND unacknowledged samples were discarded. |
| 7 | **Destructive spool recovery** | `try { parse } catch { return [] }`. One half-written record after a power cut silently discarded the entire backlog. |
| 8 | **Risk score of 0 for a device with no data** | `scoreDevice()` summed drivers; a device with no telemetry had none, scored 0, landed in the "low" band, and the UI printed **"No action needed"** about a machine nobody was monitoring. |

Underneath all of it: `device_alerts.state` had no CHECK constraint, and five live
rows hold the value **`'Tamil Nadu'`**. Because the open-alert index was
`WHERE state <> 'resolved'`, those five rows permanently occupied the open-alert
slot for equipment 37–41 — no genuine alert could ever have opened on them.

**Evidence produced:** 205 new automated tests — 132 backend against real
PostgreSQL, 40 gateway (including 12 against a real Modbus TCP server), 33
Playwright in a real browser — the full backend suite at **1,474 passing,
0 failing**, a measured capacity sweep to 1,000 devices, and live HTTP proof of
the tenant-isolation fix. Five defects were found *by the new tests in the new
code* and fixed — a partial index that could not serve as an `ON CONFLICT`
arbiter, a lock-ordering deadlock, an IP rate limiter that discarded 4,500
samples, a commissioning tool that aborted after a successful run, and a backend
test that reached into the gateway package and made the backend un-deployable —
all five are described below rather than quietly corrected.

**Gap closure, 2026-09-15.** All twelve gaps this report originally left open are
closed or reduced to the physical dependency above. That includes the three that
were not merely missing features: the §74 ERP loop (a part replacement now reaches
inventory, serial genealogy and a balanced journal entry), multi-channel
notification delivery (a rule asking for SMS previously did nothing at all), and
the Modbus client path (which had never run). Every reconciliation check now reads
zero. Section L lists what changed and what remains.

---

# B. Security

## The fix

`backend/src/modules/iot/scope.js` replaces the fail-open pattern. `iotScope(req)`
returns a tagged result; a missing company scope is `{ok: false}`, and every
handler begins:

```js
const scope = iotScope(req);
if (!scope.ok) return denyScope(res, scope);
```

Only an explicitly global scope — a super-admin, which `verifyToken` marks with
`isGlobal: true` — may read across companies. Writes by a global caller must name
their company (`writeCompany()`), because the old `req.scope?.company_id ?? 1`
silently filed super-admin writes under company 1.

## Proof, over real HTTP

A real user was created with the `service_manager` role (which holds
`iot.can_view`) and **no `user_scope` row** — the exact population that previously
received everything:

```
user 2417, role service_manager, user_scope rows = 0

DENIED 403  /iot/devices                         NO_COMPANY_SCOPE
DENIED 403  /iot/fleet/summary                   NO_COMPANY_SCOPE
DENIED 403  /iot/alerts                          NO_COMPANY_SCOPE
DENIED 403  /iot/rules                           NO_COMPANY_SCOPE
DENIED 403  /iot/ops/health                      NO_COMPANY_SCOPE
DENIED 403  /iot/ops/reconcile                   NO_COMPANY_SCOPE
DENIED 403  /iot/export/telemetry                NO_COMPANY_SCOPE
DENIED 403  /ai/predict/device-failure           NO_COMPANY_SCOPE
DENIED 403  /iot/devices/37                      NO_COMPANY_SCOPE
DENIED 403  /iot/devices/37/telemetry            NO_COMPANY_SCOPE
DENIED 403  POST /iot/rules                      NO_COMPANY_SCOPE
```

## Rule → equipment ownership, enforced twice

A rule could previously target any `equipment_id`. It is now checked in the
application *and* in the database, via a composite foreign key:

```sql
ALTER TABLE customer_equipment ADD CONSTRAINT uq_customer_equipment_company_id UNIQUE (company_id, id);
ALTER TABLE device_alert_rules  ADD CONSTRAINT fk_rule_equipment_company
  FOREIGN KEY (company_id, equipment_id) REFERENCES customer_equipment (company_id, id);
```

The application check produces a useful message; the FK makes it impossible for
any future writer that forgets. Both are tested — the DB-level one by asserting
that a raw INSERT is rejected.

The stale-rule cron's join carried no company predicate at all
(`r.equipment_id = ce.id OR (r.equipment_id IS NULL AND ce.company_id = r.company_id)`),
so a device-specific rule matched a device in another company with the same id.
It now joins `ce.company_id = r.company_id` on both branches.

## Credential lifecycle

`iot_device_tokens` records provision / rotate / revoke with actor, timestamp and
reason. A partial unique index enforces **exactly one active token per device**.
Revocation clears the equipment hash *and* marks the token, so ingest stops on the
next request rather than when somebody remembers to rotate. A disabled or revoked
device is refused at `deviceAuth` with a distinct 403 code. The token history API
returns the prefix and status, never the secret.

## Cross-company results

| Test | Result |
| --- | --- |
| Company A resolves Company B device | `null` (404 at the API) |
| Company A fleet list contains B's devices | No |
| Company A provisions B's device | 404 |
| Company A creates a rule on B's equipment | 403 `CROSS_COMPANY_EQUIPMENT` — and the raw INSERT is refused by the FK |
| Device A's token writes to device B | 401, zero rows written |
| No-scope caller reads anything | 403 `NO_COMPANY_SCOPE` |

Live reconciliation across the whole database: `cross_company_rules 0`,
`cross_company_alerts 0`, `cross_company_telemetry 0`.

---

# C. Telemetry integrity

## Idempotency

Three layers, all in the database rather than in application judgement:

1. `UNIQUE (equipment_id, sample_uid, ts)` on `device_telemetry`. `ts` is in the
   key because the table is partitioned on it; a retry resends the identical event
   stamp, so the tuple still collides.
2. `iot_ingest_batches` with `UNIQUE (equipment_id, batch_uid)` storing the
   original response. A replayed batch gets **that response back**, so the gateway
   can drop it from its spool exactly as if the first reply had arrived.
3. The gateway derives `batch_uid` from a hash of its sample ids, so a retry of
   the same content carries the same batch identity without needing to remember it
   across a restart.

Measured over HTTP: first send `accepted: 2`; retry returns `replayed: true,
accepted: 2` and stores **nothing new**. Five concurrent inserts of the same
sample produce exactly one row.

> **A defect found by the new tests, in the new code.** The first version of the
> dedup index was partial (`WHERE sample_uid IS NOT NULL`). A partial index cannot
> serve as an `ON CONFLICT` arbiter unless every INSERT repeats the predicate, so
> the ingest path would have failed on its very first duplicate — precisely when
> deduplication was supposed to work. The suite caught it; the index is now plain,
> which is also correct for legacy rows because unique indexes treat NULLs as
> distinct.

## Timestamp model

`event_ts` (the device's view) and `received_at` (the server clock) are separate
columns. **Liveness is driven by receipt, never by the device's stamp.**

| Condition | Outcome |
| --- | --- |
| More than 120 s in the future | Rejected, quarantined `FUTURE_TIMESTAMP` |
| Older than 1 hour | Accepted as `REPLAY` — stored in history, excluded from the latest-value cache, from liveness and from alerting |
| Older than 30 days | Rejected, quarantined `TOO_OLD` |

Proven: a sample dated tomorrow returns 422 and `last_seen_at` is byte-identical
before and after. A three-day-old sample is stored with `quality_code = 'REPLAY'`
and the latest value still reads the live measurement, not the old one.

## Out-of-order

The latest-value upsert carries `WHERE device_latest.ts < EXCLUDED.ts`. Tested
directly with the audit's own example — 100, 105, 110, then a late 103 — the
current value stays **110**.

The alert engine processes each window in **event-time order** and refuses to let
a sample older than one it has already evaluated advance the machine. Out-of-order
samples are kept in history; they do not rewrite a decision already taken. This is
a stated policy, not an accident, and it is the reason one E2E scenario runs on its
own device with a monotonic clock.

## Quality

`quality_code` replaces the write-only SMALLINT, with a nine-state vocabulary and
four policies (`valid_only`, `include_suspect`, `history`, `all`). An unrecognised
flag degrades to `SUSPECT`, never to `VALID` — silently upgrading unknown quality
is how bad data became trusted data. Only `VALID`/`SUSPECT` may touch the
latest-value cache or liveness; alerts default to `VALID` only.

## Range and capability

A metric must exist in `iot_metric_definitions` and its value must fall inside the
declared physical range. `FREQUENCY = 899` is rejected `OUT_OF_RANGE` and stored
nowhere. An undeclared metric is `UNKNOWN_METRIC`, not a new series. Where a device
profile declares capabilities, a metric the model does not publish is
`NOT_SUPPORTED_BY_PROFILE`. Everything rejected lands in `iot_rejected_samples`
with its reason, and is surfaced on the Data Quality page.

## Transaction integrity

The suite includes a test that **demonstrates the original defect**: it inserts
telemetry, runs a failing statement inside the same transaction, catches the error
exactly as the old code did, and asserts the next statement fails with SQLSTATE
`25P02`. That is the mechanism by which a ticket failure destroyed a telemetry
batch.

Ingest now commits telemetry + alert rows + an outbox event together. Tickets and
notifications are produced afterwards by a worker.

> **A second defect found by the new tests.** The capacity run surfaced
> `deadlock detected` (2 failures in 30 concurrent batches). Two batches for the
> same device took locks in opposing orders: one held a `device_latest` row and
> waited for `customer_equipment`; the other held `customer_equipment` and waited
> for the `device_latest` row. Ingest now takes the **device row lock first**, so
> every batch for a device has one consistent serialisation point, and the
> latest-value upserts are additionally ordered by metric name. Re-measured at
> double the concurrency: **0 errors**.

---

# D. Gateway

Eight defects fixed, each with a test that names it:

| # | Defect | Fix |
| --- | --- | --- |
| 1 | Re-entrant flush; removal by count | Single-flight guard; removal **by sample id** |
| 2 | One bad line discarded the whole spool | Line-by-line recovery; bad lines quarantined with a timestamp |
| 3 | In-place `writeFileSync` | Temp file → `fsync` → atomic `rename` |
| 4 | Disk errors only logged | Degrades to memory-only, says so loudly, reports it in the heartbeat, recovers automatically |
| 5 | Silent overflow | Counted, logged, **dead-lettered**, with warning and critical thresholds before the cap |
| 6 | Poison batch retried forever | A 4xx that is not 401/403/429 dead-letters the batch; the queue moves on |
| 7 | No retry discipline | Exponential backoff with ±25 % jitter, capped; `Retry-After` honoured on 429 |
| 8 | No sample identity | `sample_uid` + `seq_no` per sample, content-derived `batch_uid` per flush |

Lifecycle: `QUEUED → IN_FLIGHT → ACKNOWLEDGED → removed`, with
`IN_FLIGHT → FAILED → QUEUED` on retry and `→ DEAD_LETTER` for permanent
rejection. A sample is removed **only** on acknowledgement or dead-lettering.

Also added: `SIGHUP` config reload without losing the queue, shutdown that waits
up to 20 s for an in-flight flush rather than racing it, and a heartbeat reporting
queue depth, oldest queued sample, spool size, free disk, errors, dead-letters,
retries and the **actual** poll interval.

Outage behaviour, measured: a 503 holds all samples and sets a retry delay; an
immediate second attempt does not reach the server; a 401 holds data rather than
dead-lettering it (a credential problem must not destroy good telemetry); a
connection failure after a server-side commit is retried with identical sample and
batch identities, and the server replays its original response.

---

# E. Alerts

## State machine

```
NORMAL ──breach observed──► (breach timer starts)
   └─ held for persistence_secs ──► ACTIVE           (incident opens)

ACTIVE ──operator──► ACKNOWLEDGED
ACTIVE / ACKNOWLEDGED ──value clears clear_threshold──► RECOVERY_PENDING
RECOVERY_PENDING ──clear held for recovery_secs──► RESOLVED   (cooldown starts)
RECOVERY_PENDING ──breaches again──► back to its previous live state
any live state ──maintenance window──► SUPPRESSED
```

`RESOLVED` is terminal for an incident. A new breach after resolution and cooldown
is a **new incident with a new `incident_uid`**.

Transitions are validated: the old handler ran
`UPDATE device_alerts SET state='acknowledged' WHERE id=$1` with no state
predicate, so a resolved alert could be acknowledged and its `acknowledged_at`
rewritten. Illegal transitions now return **409** with the legal next states, which
the Alert Centre drawer displays.

## Verified behaviours

| Behaviour | Result |
| --- | --- |
| Intermediate breach inside a batch | Detected; `worst_value` = 12.5, the middle sample |
| Persistent breach across three batches | ONE incident, `breach_count` 3 |
| Value inside the hysteresis band | No state change |
| Recovery below the clear threshold | Resolved, `resolution_source = telemetry_recovery` |
| Re-breach after resolution | NEW incident, different `incident_uid` |
| `COMMUNICATION_ERROR` sample | No alert opened |
| Maintenance window open | Suppressed, counted |
| `RESOLVED → ACKNOWLEDGED` | Refused, `ILLEGAL_TRANSITION` |
| Another company's alert | `NOT_FOUND` |
| Two live alerts for one (equipment, rule) | Impossible — partial unique index |

Hysteresis is also validated at configuration time: a clear threshold on the wrong
side of the trigger is rejected with *"clear_threshold (9) must be BELOW threshold
(8) for a '>' rule, or the alert can never clear"*.

---

# F. Service integration

```
Telemetry → Alert → Outbox event → Worker → Service ticket → Technician
                                                    ↓
                    Equipment history (iot_device_events) ← Telemetry recovery
```

The worker creates one `support_tickets` row per critical incident, carrying the
device's project, serial, AMC and customer so it is actionable on arrival. It is
idempotent twice over: a unique `dedupe_key` on enqueue, and a conditional
`UPDATE ... WHERE ticket_id IS NULL` on link.

Failure handling is the point of the design: exponential backoff with jitter, then
a **dead-letter** state that stays visible on the IoT Health page and is replayable
once the cause is fixed. An alert can no longer lose its ticket silently.

**Telemetry recovery does not close the engineer's ticket.** The condition
clearing says the reading is back to normal; it does not say the parts are fitted
or the job is done. The ticket is annotated instead — verified by asserting the
ticket is still `Open` with a "Telemetry recovered" note after the incident
resolves.

Navigable, and verified by test: the alert API returns `ticket_number`,
`ticket_status`, `ticket_priority`, `technician_name` and `ticket_created_at`; the
Alert Centre drawer links to the ticket, the device, the customer, the project and
the AMC.

---

# G. Electrical measurements

42 metrics declared in `iot_metric_definitions`, each with unit, physical range,
precision, aggregation method, quality policy, whether rising is degradation, and
whether it is a monotonic counter.

Voltage (`V_L1..L3`, `V_L12/23/31`) · Current (`I_L1..L3`) · `FREQUENCY` ·
`KW`/`KVAR`/`KVA` · `PF`/`PF_DISP` · `ENERGY_KWH`/`KVARH`/`KVAH` ·
`THD_V_L1..L3`/`THD_I_L1..L3` · `HARMONIC_03..13` · `V_UNBALANCE`/`I_UNBALANCE` ·
`COMP_CURRENT`/`COMP_REACTIVE`/`LOADING_PCT`/`THD_I_PRE`/`THD_I_POST` ·
`DC_BUS_VOLTAGE`/`TEMPERATURE`/`FAN_SPEED`/`MODULE_STATUS`/`TRIP_CODE`.

Metrics are **capability-gated** per device type: `COMP_REACTIVE` is offered on SVG
and STATCOM; `THD_I_PRE`/`THD_I_POST` only on AHF.

## The maths, each with its definition attached

Every ratio in `ratios.js` returns numerator, denominator, window, population,
formula and a `state` — never a bare number, and never `0` where the answer is
"undefined".

| Quantity | Treatment | Tested |
| --- | --- | --- |
| **Power factor** | **kWh / kVAh**, energy-weighted. Never the arithmetic mean of PF samples, which weights a minute at 2 kW the same as a minute at 200 kW. Fallback: kWh / √(kWh²+kVArh²) | 100 kWh / 125 kVAh → 0.80 |
| PF sign | Positive = lagging, negative = leading. Never `abs()` | Leading case returns −0.80 |
| PF with no energy | `NO_DENOMINATOR` — undefined, **not 1.0** | ✔ |
| **Energy counters** | Sum of per-step increases with reset and rollover detection. Never last minus first | Reset → 25; 16-bit rollover → 15 |
| Unbalance | NEMA: max deviation from the mean ÷ mean. Needs all three phases | Two phases → `INSUFFICIENT_DATA` |
| Harmonic reduction | (pre − post) / pre. Needs BOTH | One missing → `INSUFFICIENT_DATA` |
| Online % | online ÷ **provisioned** (never-connected counted, unprovisioned excluded) | ✔ |
| Sample delivery % | valid received ÷ (window ÷ interval × metrics), devices without an interval excluded, caveat stated | ✔ |
| Data coverage % | valid samples ÷ expected, shown next to every chart | ✔ |

## Trend and risk

`linearTrend()` requires **30 samples over 6 hours with R² ≥ 0.3**. The old query
was `regr_slope ... HAVING COUNT(*) >= 5`, and five points were extrapolated into
"reaches 9.0 in ~3 days" and shown as a maintenance instruction. Below the
threshold the answer is `INSUFFICIENT_DATA`, and `daysToThreshold()` returns every
assumption — current value, threshold, slope, window, sample count, R², calculation
time — alongside the projection.

The score is named **Condition Risk Score**, not failure probability, and a device
with no evidence returns `state: INSUFFICIENT_DATA` with *"No telemetry, no alerts
and no connection history for this device — its condition is unknown"*, replacing
"No action needed". Every driver carries its evidence (`"OLS over 47 samples /
18.2h, R²=0.81"`), and `INSUFFICIENT_DATA` sorts to the **top** of the fleet
ranking, not the bottom.

## Uptime / MTBF / MTTR

Computed from `iot_device_events`, never from the current connection state. Each
refuses below its minimum: MTBF needs 2 failures (flagged low-confidence below 3),
MTTR needs 2 completed repairs (an open fault is excluded from the mean rather than
counted as a repair of duration "so far"), uptime needs 24 hours of window and is
per-device because averaging device uptimes would weight a one-device site like a
fifty-device one.

---

# H. Live monitoring

**Polling**, not WebSocket or SSE — the honest choice for this architecture. The
server has no event bus, and a WebSocket layer would be new infrastructure for a
page whose data changes on a 60-second poll cycle. The interval is user-selectable
(off / 15s / 30s / 1m / 5m), pauses while the tab is hidden, and refreshes on
return.

| Requirement | Implementation |
| --- | --- |
| Genuinely live | Interval polling of both the fleet AND the selected device panel (the old page refreshed the list and left the open panel frozen) |
| Last updated / data age | Shown in the header and per device, from a ticking clock in state |
| Request race | Every request carries a token checked on arrival; in-flight requests aborted on change; the selected metric is revalidated against the new device |
| States | `LOADING` / `SUCCESS` / `EMPTY` / `ERROR` / `UNAUTHORIZED` / `INSUFFICIENT_DATA` — distinct screens. **No numbers are rendered beside an error message**, because an error next to a zero reads as a measurement of zero |
| Missing GPS | Never plotted. A stored `0,0` is also skipped as a coerced null. The map footer says "*N* devices not shown — location not recorded" |
| `NEVER_CONNECTED` | Its own state with its own KPI tile, labelled "not a fault — not yet commissioned" |
| KPIs | From `/iot/fleet/summary` over the whole population; the search box changes the list and is labelled "filtering the list only" |
| Responsive | Two-column grid collapses below 1024px; the detail panel stops being sticky; tables scroll inside their own container |

Proven by test: a search that matches nothing empties the list while
`fleet/summary.provisioned` is unchanged.

---

# I. Testing

## Executed, with results

| Suite | Tests | Result |
| --- | --- | --- |
| `backend/src/__tests__/iot.phase4.test.js` (real PostgreSQL) | 48 | **48 passed** |
| `backend/src/__tests__/iot.ingest.e2e.test.js` (real HTTP + real PostgreSQL) | 34 | **34 passed** |
| `edge-gateway/__tests__/gateway.spool.test.mjs` (real HTTP server) | 13 | **13 passed** |
| `edge-gateway/__tests__/modbus.decode.test.mjs` | 10 | **10 passed** |
| `tests/suites/20-iot.spec.ts` (real browser, Playwright) | 33 | **33 passed** |
| **Full backend suite** (69 files) | 1,524 | **1,515 passed, 0 failed, 9 skipped** |
| Frontend lint (4 IoT pages) | — | 0 errors, 0 warnings |
| Frontend build | — | passes; all four pages code-split |

**Independently re-verified on 2026-09-15 (third pass)**, every figure re-run
from a clean checkout rather than carried forward: backend IoT suites 132 passed
(48 + 21 + 34 + 16 + 13), edge gateway 40 passed, Playwright `iot` project 33
passed in a real browser, full backend suite 1,515 passed / 0 failed / 9 skipped
across 69 files. The full-suite total is higher than the 1,408 recorded above
because the suite has grown since; the point of re-running it was that no IoT
change had broken anything outside IoT, and none had.

That pass also found one defect this report had missed and one sentence it had
stated wrongly — see "the backstop did not exist" in section K.

An earlier full-suite run showed 6 failures in an unrelated procurement suite.
Cause: the spare backend I had running on port 5099 for HTTP probing pushed the
run past the connection budget documented in `vitest.config.js`. With it stopped,
the suite is green and the failing suite passes in isolation. Recorded because the
first number was real and someone re-running this deserves to know why.

## §61 scenarios

| # | Scenario | Where | Result |
| --- | --- | --- | --- |
| 1 | Normal operation | E2E | Online, latest cache correct with registry units, ONLINE event written once (not per poll) |
| 2 | THD breach | E2E | Critical incident, correct severity, threshold and worst value |
| 3 | Persistent breach | E2E | ONE incident, `breach_count` grows, no duplicate ticket |
| 4 | Recovery | E2E | Resolved by telemetry, ticket link retained, ticket left open |
| 5 | Gateway outage | Gateway suite | Queue grows, spool persists, no loss, retry after recovery, no duplicates |
| 6 | Lost HTTP response | E2E + gateway | One logical sample; replay returns the original response |
| 7 | Bad timestamp | E2E | Future rejected and liveness untouched; old accepted as REPLAY without touching the latest value |
| 8 | Bad quality | E2E | Out-of-range quarantined; communication errors excluded from the latest value |
| 9 | Cross-company | E2E + live HTTP | Denied on every surface |
| 10 | Service event | E2E | Alert → ticket → technician visible → equipment history → recovery |

## §59 real-database tests

All ten required cases run against real PostgreSQL: ingestion commit + lost
response, retry deduplication, out-of-order data, future timestamps, quality
rejection, ticket SQL failure (including a demonstration of the 25P02 abort),
transaction rollback, alert uniqueness, company isolation, and concurrent
ingestion (5-way race producing exactly one row; two outbox workers claiming
disjoint sets via `FOR UPDATE SKIP LOCKED`).

---

# J. Hardware validation

**NOT PERFORMED.** No device, no model, no register evidence. See
`IOT_HARDWARE_PILOT.md` for the full protocol, per-quantity tolerances and
sign-off sheet.

What *is* done: the decoder supports one/zero-based addressing, big/little byte
order and big/little word order, all configurable per device profile, each
unit-tested against a known bit pattern (IEEE-754 415.5 = `0x43CFC000`). One test
asserts explicitly that a word-swapped float decodes to a **finite, plausible,
wrong** number under the old hardcoded convention — which is why this needs
hardware and not more code.

The three shipped profiles are `is_template = TRUE` with an **empty register map**
and no manufacturer or model, so nobody can mistake them for verified mappings.
The simulator prints `SIMULATOR SOURCE ACTIVE — values are synthetic and are NOT
hardware evidence.` on every start.

---

# K. Performance

Measured by `backend/scripts/iot-capacity-test.mjs` against the running server and
the live database. Developer laptop, database on localhost, server sharing the same
CPU — a floor for relative comparison, not a production capacity guarantee.

8 metrics per device, 3 batches per device, 20 concurrent requests:

| Devices | Samples | Ingest p50 | p95 | max | Samples/s | Retry p50 | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 240 | 187 ms | 279 ms | 280 ms | 792 | 18 ms | 0 |
| 100 | 2,400 | 107 ms | 178 ms | 206 ms | 1,422 | 43 ms | 0 |
| 500 | 12,000 | 87 ms | 143 ms | 235 ms | 1,697 | 27 ms | 0 |
| 1,000 | 24,000 | 77 ms | 121 ms | 412 ms | 1,914 | 23 ms | 0 |

Latency **falls** as device count rises because the per-batch cost is dominated by
fixed overhead that amortises; throughput scales to ~1,900 samples/s. The
already-committed-batch replay path costs 12–43 ms — cheap enough that a retry
storm is not itself a threat.

**API latency at 1,000 devices / 24,000 samples:** fleet summary 23 ms, device list
23 ms, alert centre 39 ms, device 360 20 ms, 24 h history 15 ms, 30 d history 14 ms,
condition risk 16 ms, platform health 81 ms, **data quality 344 ms** (the slowest,
and the one to watch as history grows).

## The rate-limiting finding (§57), measured

The first sweep returned **4,500 HTTP 429s and stored nothing**. The cause is the
global limiter, keyed on `req.ip` at 300/min. All test traffic came from one IP —
which is exactly the production situation the audit describes: several gateways at
one customer site share a public IP, so one chatty gateway exhausts the budget for
every other device behind the same NAT.

Fixed by adding a **per-device limiter** on the ingest route keyed on the
authenticated device identity (`IOT_DEVICE_RL_MAX`, default 120/min), which is what
actually bounds a device. **The global default of 300/min is still too low for a
multi-gateway site** and must be raised per deployment — see section L.

### Correction, 2026-09-15 (third pass): the backstop did not exist

This section previously claimed "the IP limiter stays underneath as a backstop
against unauthenticated floods." **That was wrong**, and the error mattered. The
`skip()` in `server.js` excluded `/iot/ingest` and `/iot/gateway/heartbeat` from
the IP limiter *unconditionally* — not just for authenticated traffic — and the
per-device limiter could not stand in for it, because `deviceAuth` runs first and
an unauthenticated caller is rejected before ever reaching it. So the two
device-facing routes had **no ceiling whatsoever** for traffic that never
authenticates.

Reproduced against the running server:

| Probe, 400 requests from one IP | Before | After |
| --- | --- | --- |
| unauthenticated `POST /iot/ingest` | 400 × 401, **0 × 429** | capped at 600 failures/min, remainder 429 |
| unauthenticated `GET /iot/devices` (control, not excluded) | 300 × 401, 100 × 429 | unchanged |

Each of those 401s costs an indexed `SELECT` with a `LEFT JOIN`: `deviceAuth` has
to look the device up before it can say the token is wrong. The endpoint was a
credential-free way to make the database do unbounded work — an availability
defect, not a data-exposure one, which is why every isolation test still passed
over it.

**Fixed** by a pre-auth limiter on both routes (`IOT_PREAUTH_RL_MAX`, default
600/min per IP) that counts **only the requests that fail**. Valid telemetry never
moves the counter, so a site with any number of gateways behind one NAT is never
throttled and the original defect does not return.

Count-and-refund was tried first and is subtly wrong: once the counter is over
budget the limiter rejects at entry, so a legitimate device is turned away before
it can earn its refund. Measured while building it — 60 valid batches behind an
exhausted counter returned **60 × 429**. Counting only failures has no such
window.

**The accepted trade**, asserted by a test so it stays a decision rather than a
surprise: an IP that has produced 600 auth failures in a minute is throttled
entirely until the window rolls, valid traffic included. An attacker is not
normally behind the customer's NAT, and a site whose own gateways are failing auth
600 times a minute has a broken deployment rather than a rate-limiting problem.

---

# L. Remaining gaps

## Closed on 2026-09-15

| # | Gap | How it was closed | Proof |
| --- | --- | --- | --- |
| 2 | Frontend E2E tests | `tests/suites/20-iot.spec.ts`, registered as the `iot` Playwright project. Covers all six pages plus a mobile viewport. Includes a case for each of the three front-end defects: the late-response race, a 500 rendering as empty, and KPIs derived from a filtered list | **29/29 passing** in a real browser |
| 3 | Email / SMS / push | `modules/iot/notify.js` fans out to in-app, push, email and SMS through the senders the rest of Pulse already uses. `notification_rules` seeded per company per event. Every attempt writes an `iot_notification_log` row with its outcome; the rule editor disables a channel this deployment cannot deliver and states why | 7 tests; Alert 360 shows the delivery record |
| 5 | Global IP rate limit | Device ingest and heartbeat are now **excluded** from the IP-keyed global limiter, which is a site limit one gateway can exhaust for its neighbours. The per-device limiter — applied after the token is verified — is the bound that corresponds to a device. `IOT_INGEST_SHARE_GLOBAL_RL=true` restores the old behaviour | 500 devices / 12,000 samples at **default** limits: **0 errors** (was 1,500 errors, 0 stored) |
| 6 | Equipment 360 | A standalone page: identity, the business chain, **as-built genealogy** (serial, batch, production order, serial history), parts consumed with their downstream links, incidents with technicians, and lifetime parts cost | 3 Playwright cases; `equipmentGenealogy()` tested |
| 7 | **§74 ERP loop** | `modules/iot/serviceParts.js`. One part issue writes, in ONE transaction: a `spare_parts_movements` issue, a `stock_ledger` line, a `serial_events` COMPONENT_REPLACED entry, a **balanced draft journal entry** (Dr Warranty Cost or Repairs & Maintenance / Cr Stores & Spares Inventory, chosen by cover), a `PART_REPLACED` device event and the ticket's `parts_cost`. Reversible without deleting the original | 9 tests asserting each link individually, including the double-entry account codes |
| 8 | Legacy seed rows | Archived whole into `iot_legacy_quarantine` as JSONB with the reason, then removed. The CHECK and FK constraints are now **VALIDATED**, so the database guarantees the vocabulary for every row rather than only for new ones | 35 rows archived; `convalidated = true` on all 7 constraints |
| 9 | Default partition | Emptied with the same archive. The partition cron is no longer blocked | `device_telemetry_default` = 0 rows |
| 11 | Mobile | Playwright runs the fleet and alert pages at 390×844 and asserts no horizontal body scroll, a single-column grid and a non-sticky detail panel | 4 mobile cases passing |
| 12 | Metric registry UI | `MetricRegistry.jsx` — metric CRUD with tenant overrides of the global catalogue, and device-profile CRUD **including a register-map editor**. Validated on save: unknown metric, duplicate, bad address or type are refused | 4 Playwright cases; CRUD routes scope-guarded |
| 10 | Partition dropping | Unchanged and still opt-in (`IOT_PARTITION_DROP_ENABLED`). This was never a defect — dropping a partition destroys data, and that should be a deployment decision | — |

Reconciliation after closure — every check zero:

```
cross_company_rules      0      invalid_alert_state      0
cross_company_alerts     0      invalid_rule_operator    0
cross_company_telemetry  0      undeclared_metrics       0
duplicate_samples        0      default_partition_rows   0
```

## Closed on 2026-09-15, second pass — everything around the pilot

The pilot itself needs a device. Everything that stood in front of it did not.

| Item | Was | Now | Proof |
| --- | --- | --- | --- |
| **The Modbus client path** | `modbus-serial` was an optional dependency that had **never been installed**, so `createSource()` had never executed. Connect, read, per-register failure handling, link-drop and reconnect were all unverified | Installed and driven against a **real Modbus TCP server** | 12 tests: holding + input reads, int16/int32/uint32/float32 over the wire, scale and offset, one-bad-register isolation, offline-then-recover, reconnect interval honoured |
| **Establishing the conventions** | Edit config → restart gateway → re-read the display, once per combination per register. An afternoon that ends with somebody picking the value that looks about right | `verify.mjs` reads each register ONCE and decodes the same bytes under all four conventions side by side, with the raw hex, under both addressing modes | 5 tests driving it as a process, incl. an unreachable device producing a diagnosis rather than a stack trace |
| **The pilot result** | A markdown form. Six months later "was this register ever verified, by whom, against what?" had no answer | `iot_hardware_pilots` + `iot_hardware_pilot_readings`, holding the **raw bytes** so a wrong map can be re-decoded later | 16 unit + 13 end-to-end tests |
| **Self-certification** | Nothing prevented it, because nothing recorded it | A pilot cannot pass without a named engineer, a named reference instrument, three confirmed conventions and a register compared to something outside Pulse. **Three layers**: the button is disabled, the API returns `409 PILOT_INCOMPLETE` naming every blocker, and a CHECK constraint refuses the row | The end-to-end suite walks a real refusal, then a pass |
| **Knowing where you stand** | The Fleet Monitor being green implied the readings were right | `GET /iot/pilots/status` answers it from data: *"NO hardware pilot has passed. Every register map in this company is unverified."* | 4 Playwright cases |

### The design rule these enforce

**A successful read is not evidence.** The device answering proves the transport
works; it says nothing about whether the number means what the profile claims.
Every layer above is built around that one distinction:

- the commissioning tool posts pilots as `in_progress` and **cannot** create a passed one
- it leaves the `observed` block of its evidence file **empty** — a test asserts this, because a tool that helpfully pre-filled its own best guess would be manufacturing the evidence the pilot exists to collect
- a register cannot be marked passed without numbers that support it; `NO_COMPARISON` comes back with the actual difference
- the difference and the verdict are **computed** server-side, never accepted as a claim

## Closed on 2026-09-15, third pass — an unbounded pre-auth surface

A re-verification pass, run to check this report against the code rather than to
trust it, reproduced one defect the previous two passes had missed.

| # | Gap | What it was | Fix |
| --- | --- | --- | --- |
| A | **`/iot/ingest` and `/iot/gateway/heartbeat` had no rate limit at all for unauthenticated callers** | `server.js` excluded both from the IP limiter unconditionally, and the per-device limiter runs *after* `deviceAuth`, so it never sees a caller that fails to authenticate. 400 credential-free POSTs from one IP: 400 × 401, **zero** 429. Each costs an indexed `SELECT` with a `LEFT JOIN` — a credential-free way to make the database do unbounded work | Pre-auth limiter on both routes (`IOT_PREAUTH_RL_MAX`, default 600/min per IP) that counts **only failed** requests, so valid telemetry from a multi-gateway NAT site is never throttled. `rateLimit.js` gained a `countIf` mode for it. 3 tests in `iot.ingest.e2e.test.js`, including one asserting the accepted trade |

This one is worth noting for a reason beyond the fix: **every tenant-isolation
test passed over it**, because it is an availability defect rather than a
data-exposure one. No amount of "can company A read company B" testing would have
found it. It surfaced from re-reading a claim in this report — "the IP limiter
stays underneath as a backstop" — and then checking whether that sentence was
true. It was not.

## Still open

| # | Gap | Status | Detail |
| --- | --- | --- | --- |
| 1 | **Hardware pilot** | **MISSING** | **The only item blocking certification.** No device connected. It is now a two-hour field procedure with no engineering work in front of it — `IOT_HARDWARE_PILOT.md` |
| 4 | Modbus against real hardware | **PARTIAL** | The client path, every decode convention, partial failure and reconnect are proven against a real Modbus TCP server. What remains unverified is which convention and scale a PARTICULAR device uses — a fact about hardware, not about the protocol (same root cause as #1) |

### Deliberate design decisions, not gaps

- **In-app is never disabled.** A rule can add channels but cannot remove in-app, so an alert is never completely silent.
- **Telemetry recovery does not close a service ticket.** The condition clearing is not the repair being finished.
- **A global catalogue metric cannot be edited by a tenant** — a company creates an override with the same code, so one tenant cannot change what a metric means for the others.
- **Shipped device profiles carry no register map** and are read-only, so a generic profile cannot be mistaken for a verified one.
- **`notified_at` is set only when someone was actually reached.** An alert that matched no recipient records `no_recipients` in the delivery log and leaves `notified_at` null. This changed one pre-existing assertion, and the new behaviour is the point: an alert that reached nobody must look like an alert that reached nobody.

---

# Certification gates

## GATE A — SECURITY ✅
```
[x] company isolation            proven at API and DB level, live HTTP + tests
[x] missing scope denied         403 NO_COMPANY_SCOPE on every endpoint
[x] resource ownership enforced  scopedEquipment + composite FK
[x] token lifecycle secure       provision/rotate/revoke/disable/enable, one active token
[x] permission enforcement       requirePermission, fails closed
[x] no stored HTML injection     no IoT field is rendered as HTML
[x] pre-auth abuse bounded       device routes were unlimited for unauthenticated
                                 callers; failure-counting IP limiter, 3 tests
                                 (added 2026-09-15, third pass)
```

## GATE B — TELEMETRY INTEGRITY ✅
```
[x] idempotency                  unique index + batch ledger, tested concurrently
[x] duplicate prevention         database-enforced, not application-judged
[x] event vs receipt timestamp   separate columns; liveness from receipt
[x] out-of-order handling        latest-value guard + event-ordered evaluation
[x] future timestamp handling    rejected and quarantined; liveness untouched
[x] quality enforcement          9 states, 4 policies, unknown degrades to SUSPECT
[x] transaction integrity        outbox; the 25P02 defect is demonstrated by a test
```

## GATE C — GATEWAY ✅
```
[x] single-flight flush          guard + removal by id, tested with overlapping flushes
[x] durable spool                atomic temp+fsync+rename
[x] crash recovery               line-by-line, quarantine, never silently empty
[x] retry                        with identity that makes it safe
[x] backoff                      exponential + jitter, Retry-After honoured
[x] dead-letter                  overflow and poison batches, with reasons
[x] overflow observability       counted, logged, reported in the heartbeat
```

## GATE D — LIVE MONITORING ✅
```
[x] genuine live refresh         configurable polling, visibility-aware
[x] selected-device refresh      the panel polls too
[x] stale indication             state + data age + last received
[x] offline indication           offline and NEVER_CONNECTED distinguished
[x] request race protection      token check + AbortController
[x] truthful API errors          no numbers rendered beside an error
```

## GATE E — ALERTS ✅
```
[x] state machine                6 states, explicit legal transitions
[x] persistence                  configurable hold before opening
[x] hysteresis                   clear threshold, validated for direction
[x] recovery                     telemetry-driven, with a recovery hold
[x] maintenance suppression      windows, auto-resume, tested
[x] no duplicate incidents       partial unique index + incident identity
[x] valid acknowledgement        409 with the legal next states
```

## GATE F — SERVICE ✅
```
[x] alert -> ticket              outbox worker, idempotent, retried, dead-lettered
[x] ticket visible from alert    number, status, priority, technician, dates
[x] equipment navigation         Device 360 and Equipment 360 from the alert
[x] customer navigation          from customer_equipment.crm_account_id
[x] project navigation           from customer_equipment.project_id
[x] AMC/warranty navigation      from amc_contract_id
[x] service history              iot_device_events + the ticket trail
[x] repair -> telemetry recovery telemetry is the source of truth; the ticket is
                                 annotated, never auto-closed
[x] as-built genealogy           serial master, batch, production order, serial
                                 history, reachable from Equipment 360   (2026-09-15)
[x] parts -> inventory           spare_parts_movements + stock_ledger      (2026-09-15)
[x] parts -> genealogy           serial_events COMPONENT_REPLACED          (2026-09-15)
[x] parts -> finance             balanced draft journal, account by cover  (2026-09-15)
```

## GATE G — ELECTRICAL ⚠ PARTIAL
```
[x] metric registry              42 metrics, declared and enforced
[x] unit definitions             on every metric, returned with every reading
[x] scaling                      per register: type, scale, offset
[x] device profile               capability-gated, three templates
[~] Modbus validation            every convention implemented; the CLIENT path
                                 proven against a real Modbus TCP server, incl.
                                 partial failure and reconnect (2026-09-15);
                                 register map enterable and validated in the UI;
                                 still NOT validated against a physical device —
                                 the one remaining blocker
[x] AHF measurements             declared and capability-gated
[x] SVG measurements             declared and capability-gated
[x] STATCOM measurements         declared and capability-gated
[x] ratio definitions            numerator, denominator, window, population, formula
[x] energy counter handling      reset and rollover detection, tested
```

## GATE H — TESTING ⚠ PARTIAL
```
[x] security tests               cross-company, no-scope, token lifecycle
[x] PostgreSQL tests             132 against the real database
[x] concurrency tests            5-way sample race, 2-worker outbox claim, deadlock
[x] gateway tests                40, incl. 12 against a real Modbus TCP server
[x] alert lifecycle tests        breach/persist/hysteresis/recover/re-breach/suppress
[x] frontend E2E tests           33 Playwright cases incl. mobile        (2026-09-15, re-run green)
[x] ERP loop tests               part -> inventory -> genealogy -> finance (2026-09-15)
[x] notification tests           delivery + the no-recipient case         (2026-09-15)
[x] pilot-evidence tests         29 tests, incl. a pilot REFUSED on read data alone
[ ] hardware pilot               MISSING (gap 1) — the only outstanding item
[x] capacity tests               10 / 100 / 500 / 1,000 devices, measured
```

---

# Certification matrix

| Requirement | Status | Evidence | Files | Tests | DB | UI | API | Remaining risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| §3 Missing scope denies | COMPLETE | Live HTTP: 11/11 endpoints 403 | `scope.js` | 4 | — | error state | all | none |
| §4 Company isolation | COMPLETE | 6 cross-company tests; reconcile 0/0/0 | `scope.js`, all routes | 6 | composite FK | — | all | none |
| §5 Rule↔equipment ownership | COMPLETE | App check + FK; raw INSERT rejected | `alerts.routes.js` | 2 | `fk_rule_equipment_company` | rule editor | rules | none |
| §6 Credential lifecycle | COMPLETE | Revoke stops ingest on next request | `devices.routes.js` | 4 | `iot_device_tokens` | panel | 6 routes | none |
| §7 Ingest idempotency | COMPLETE | Retry → 0 new rows; 5-way race → 1 row | `ingest.routes.js` | 4 | unique index + batch ledger | — | ingest | none |
| §8 Transaction integrity | COMPLETE | 25P02 demonstrated; outbox commits with telemetry | `outbox.js` | 2 | `iot_outbox` | health page | ingest | none |
| §9 Ticket failure isolation | COMPLETE | Backoff, dead-letter, replay | `iotOutbox.cron.js` | 3 | `iot_outbox` | health page | replay | none |
| §10 Timestamp model | COMPLETE | Future rejected, liveness untouched | `ingest.routes.js` | 3 | `received_at` | data age | ingest | none |
| §11 Out-of-order | COMPLETE | 110 survives a late 103 | `ingest`, `alertEngine` | 2 | upsert guard | — | — | none |
| §12 Quality semantics | COMPLETE | AVG excludes comm errors | `quality.js` | 4 | `quality_code` | quality shown | policy param | none |
| §13 Metric registry | COMPLETE | 42 metrics; unknown rejected; full CRUD with tenant overrides | `metricRegistry.js`, `service.routes.js` | 3 | `iot_metric_definitions` | Metric Registry page | 4 routes | none |
| §14-15 Units, scaling, Modbus | PARTIAL | 10 decode + 12 live-socket tests; register-map editor | `modbus.mjs`, `verify.mjs` | 27 | `iot_device_profiles` | registry + pilots | `/profiles` | **which convention a given device uses is unverified** |
| §16 Single-flight flush | COMPLETE | Overlapping flush → no double send | `gateway.mjs` | 1 | — | — | — | none |
| §17 Gateway durability | COMPLETE | Corrupt spool → 5 of 6 recovered | `gateway.mjs` | 6 | — | gateway tab | heartbeat | none |
| §18 Sampling config chain | COMPLETE | Configured vs actual shown | `ingest`, `devices` | — | 4 columns | panel | heartbeat | none |
| §19 Retention / partitions | COMPLETE | Cron rolls 3 months; drop opt-in | `iotPartitions.cron.js` | — | partitions | health page | — | drop is opt-in |
| §20 Live monitoring | COMPLETE | Polling + visibility-aware | `FleetMonitor.jsx` | — | — | yes | — | polling, not push |
| §21 Request race | COMPLETE | Token + AbortController | `FleetMonitor.jsx` | — | — | yes | — | no E2E test |
| §22 GPS never 0,0 | COMPLETE | Skipped + counted in the footer | `FleetMonitor.jsx` | — | — | yes | — | none |
| §23 Fleet KPI correctness | COMPLETE | Search changes list, not summary | `devices.routes.js` | 2 | — | yes | `/fleet/summary` | none |
| §24–27 Alert state machine | COMPLETE | 10 lifecycle tests | `alertEngine.js` | 10 | 20 columns + `iot_rule_state` | drawer | transitions | none |
| §28 Maintenance suppression | COMPLETE | Suppressed + auto-resume | `alertEngine`, `iotMonitor` | 1 | `iot_maintenance_windows` | panel | 3 routes | none |
| §29 Alert → ticket → service | COMPLETE | Ticket visible, technician named | `alertActions.js` | 4 | `ticket_id` | drawer | `/alerts/:id` | none |
| §30 Customer/project/AMC nav | COMPLETE | Existing entities, no duplicates | `devices.routes.js` | — | — | links | device 360 | none |
| §31 Service → IoT recovery | COMPLETE | Ticket NOT auto-closed | `alertActions.js` | 1 | — | — | — | none |
| §32 Notification engine | COMPLETE | 4 channels through Pulse's own senders; every attempt logged | `notify.js` | 7 | `iot_notification_log`, `notification_rules` | channel picker, disabled when unavailable | `/notification-channels` | SMS/email need deployment config |
| §33 Alert Centre | COMPLETE | 7 views, 9 filters, Alert 360 | `AlertCenter.jsx` | 1 | — | yes | `/alerts` | no E2E test |
| §34 Rule management UI | COMPLETE | Full CRUD + validation + preview | `AlertRules.jsx` | 3 | — | yes | `/rules` | no E2E test |
| §35 Historical telemetry | COMPLETE | 1h–90d, gaps, quality mix | `devices.routes.js` | 2 | — | range picker | `/telemetry` | none |
| §36 Aggregation correctness | COMPLETE | Coverage, sample count, buckets | `devices.routes.js` | 1 | — | shown | — | none |
| §37 Trend analysis | COMPLETE | 30 samples / 6h / R²≥0.3 | `trend.js` | 3 | — | shown | `/risk` | none |
| §38 Risk score | COMPLETE | Renamed; INSUFFICIENT_DATA | `trend.js`, `ai.routes.js` | 2 | — | yes | 2 routes | heuristic by design |
| §39 Days to threshold | COMPLETE | All assumptions returned | `trend.js` | 1 | — | shown | `/risk` | none |
| §40–43 Electrical contract | COMPLETE | PF energy-weighted; counters handled | `ratios.js` | 7 | registry | power-quality API | `/power-quality` | no hardware check |
| §44 Uptime/MTBF/MTTR/SLA | COMPLETE | Refuses below minimums | `serviceKpis.js` | 4 | `iot_device_events` | Service KPIs tab | `/service-kpis` | thin history today |
| §45 Device profiles | COMPLETE | 3 templates + company profiles with a validated register-map editor | migration, `service.routes.js` | 4 | `iot_device_profiles` | Metric Registry page | 4 routes | maps need a hardware pilot to verify |
| §46 Equipment 360 | COMPLETE | Standalone page with as-built genealogy + parts + lifetime cost | `Equipment360.jsx`, `serviceParts.js` | 4 | `iot_service_parts` | yes | `/equipment/:id/genealogy` | none |
| §47 Device 360 | COMPLETE | Every required section | `devices.routes.js` | 1 | — | panel | `/devices/:id` | none |
| §48 Alert 360 | COMPLETE | Incl. telemetry evidence + delivery | `alerts.routes.js` | 1 | — | drawer | `/alerts/:id` | none |
| §49 Gateway diagnostics | COMPLETE | 12 fields + live status | `ops.routes.js` | — | `iot_gateways` | tab | `/ops/gateways` | none |
| §50 Export | COMPLETE | CSV, scoped, audited | `ops.routes.js` | — | — | button | 2 routes | none |
| §51 Audit trail | COMPLETE | logAudit on every material action | all routes | — | `audit_logs` | — | — | none |
| §52 Permission model | COMPLETE | Matrix enforced; view-only sees no actions | `auth.middleware` | — | `role_permissions` | gated | all | none |
| §53 Frontend error semantics | COMPLETE | 6 distinct states | all 4 pages | — | — | yes | — | no E2E test |
| §54 Mobile / responsive | COMPLETE | Asserted at 390x844: no body scroll, single column, non-sticky panel | all 6 pages | 4 | — | yes | — | emulated viewport, not a physical handset |
| §55 Database integrity | COMPLETE | 14 checks, all now reading ZERO; constraints VALIDATED | migrations | 5 | 13 tables | Integrity tab | `/ops/reconcile` | none |
| §56 Performance / scale | COMPLETE | Measured to 1,000 devices | capacity script | — | — | — | — | laptop measurement |
| §57 Rate limiting | COMPLETE | Device traffic excluded from the IP limiter; per-device bound after auth | `ingest.routes.js`, `server.js` | — | — | — | — | none — 500 devices, 0 errors at defaults |
| §58-59 Test suite | COMPLETE | 155 tests across backend, gateway and browser | 6 files | 155 | real DB | Playwright | — | none |
| §60 Hardware pilot | **MISSING** | Protocol, tool, schema, API and UI all built and tested; **not run against a device** | `verify.mjs`, `pilot.routes.js`, `HardwarePilots.jsx` | 29 | `iot_hardware_pilots` | yes | 7 routes | **BLOCKING — the only one** |
| §61 E2E scenarios | COMPLETE | 9 of 10 in the HTTP suite, 1 in the gateway suite | 2 suites | 34 | real DB | — | — | none |
| §62 Business traceability | COMPLETE | Customer -> ... -> technician -> part -> inventory -> genealogy -> finance | `serviceParts.js`, `Equipment360.jsx` | 13 | `iot_service_parts` | yes | 4 routes | none |
| §63 No fabricated data | COMPLETE | Sweep clean; "not recorded" everywhere | all | — | — | yes | — | none |
| §64 API contract | COMPLETE | Every endpoint documented and verified | `IOT_API_CONTRACT.md` | 34 | — | — | — | none |
| §65 No mock data in UI | COMPLETE | Sweep found none | all | — | — | yes | — | none |
| §66 Observability | COMPLETE | Structured logs with correlation ids | all | — | — | — | — | none |
| §67 Platform health dashboard | COMPLETE | Explicitly separated from equipment health | `IoTHealth.jsx` | — | — | yes | `/ops/health` | none |
| §68 Data quality dashboard | COMPLETE | Expected/received/valid/rejected/duplicate | `IoTHealth.jsx` | — | — | yes | `/ops/data-quality` | none |
| §69 Service KPI dashboard | COMPLETE | Refuses below minimums | `IoTHealth.jsx` | 4 | `iot_device_events` | yes | `/ops/service-kpis` | thin history |
| §74 ERP integration loop | COMPLETE | One part issue writes 6 linked rows across 4 modules, atomically | `serviceParts.js` | 9 | 5 tables | Equipment 360 | `/service-parts` | none |

---

# Files

**New — backend:** `modules/iot/{scope,quality,metricRegistry,outbox,alertEngine,deviceEvents,ratios,trend,serviceKpis}.js`,
`modules/iot/routes/{alerts,ops}.routes.js`, `jobs/{iotOutbox,iotPartitions}.cron.js`,
`__tests__/{iot.phase4,iot.ingest.e2e}.test.js`, `scripts/iot-capacity-test.mjs`,
migrations `20260914000001_iot_phase4_industrial.js`, `20260914000002_iot_metric_catalogue.js`

**Rewritten — backend:** `modules/iot/routes/{ingest,devices}.routes.js`,
`modules/iot/alertActions.js`, `jobs/iotMonitor.cron.js`,
`modules/intelligence/ai.routes.js` (device-risk endpoints only), `server.js` (mounts, crons)

**New — frontend:** `features/iot/pages/{AlertCenter,AlertRules,IoTHealth,Equipment360,MetricRegistry}.jsx`
**Rewritten — frontend:** `features/iot/pages/FleetMonitor.jsx`, `config/autoRouter.js` (display names)

**Gap closure, 2026-09-15 — backend:** `modules/iot/{notify,serviceParts}.js`,
`modules/iot/routes/service.routes.js`, `__tests__/iot.gapclosure.test.js`,
migration `20260915000001_iot_gap_closure.js`, `server.js` (IoT paths excluded from the IP limiter)
**Gap closure — frontend:** `Equipment360.jsx`, `MetricRegistry.jsx`, `AlertRules.jsx` (channel picker)
**Gap closure — tests:** `tests/suites/20-iot.spec.ts`, `playwright.config.ts` (the `iot` project)

**Pilot enablement, 2026-09-15 — backend:** `modules/iot/routes/pilot.routes.js`,
`__tests__/{iot.pilot,iot.pilot.e2e}.test.js`, migration `20260915000002_iot_hardware_pilot.js`
**Pilot enablement — gateway:** `verify.mjs` (commissioning tool),
`__tests__/{modbus.integration,verify.tool}.test.mjs`, `modbus-serial` installed
**Pilot enablement — frontend:** `features/iot/pages/HardwarePilots.jsx`
**Also fixed:** `integration.crmCustomerIntegrity.test.js` — its self-cleaning sweep
had silently stopped working (a per-company `interview_questions` seed blocked the
company DELETE and `.catch(() => {})` hid it), leaving that suite permanently red
after one crashed run

**Third pass, 2026-09-15 — backend:** `middlewares/rateLimit.js` (`countIf` mode),
`modules/iot/routes/ingest.routes.js` (pre-auth limiter on both device routes),
`__tests__/iot.ingest.e2e.test.js` (+3 cases, and its own device so the
rate-limit cases stop depending on a token an earlier case rotates)

**Rewritten — gateway:** `gateway.mjs`, `sources/{modbus,sim}.mjs`, `config.example.json`, `package.json`
**New — gateway:** `__tests__/{gateway.spool,modbus.decode}.test.mjs`

**Docs:** `IOT_PHASE4_IMPLEMENTATION_MAP.md`, `IOT_API_CONTRACT.md`, `IOT_HARDWARE_PILOT.md`, this file

---

# What would close certification

**One item, and it needs a device.**

On site, against one AHF and one SVG, about two hours each:

```bash
cd edge-gateway
npm i modbus-serial
node verify.mjs --config config.json --post
```

Then in Pulse: **IoT → Hardware Pilots →** the pilot that just appeared. Enter
what the device display and the reference instrument showed, per register.
Confirm the three conventions. Complete it.

The system will refuse a pass until all of that is present, and will say exactly
what is missing. On a pass it stamps the device profile as verified, corrects its
conventions to what was confirmed, and `GET /iot/pilots/status` stops reporting
that every register map is unverified.

**Nothing else is outstanding.** Every other gap this report opened on 2026-09-14
is closed, and each has a test that fails if it returns.

## Why this one is not being worked around

It would be easy to call the Modbus integration suite "hardware validation" — it
drives a real socket, a real protocol, real function codes, and it is green. It is
not hardware validation, and one of its own tests says so: the same registers read
with the wrong word order come back **finite, plausible and wrong**, flagged
`VALID`, because nothing in the protocol disagrees. A server that answers whatever
the test asked it to cannot settle what a particular AHF means by register 40001.

Only the device can. Until it does, this reads NOT CERTIFIED.
