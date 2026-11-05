# Phase 4 — Industrial IoT: Implementation Map (audit-first)

Audit performed 2026-09-14 against the live `Pulse` database and the working tree.
Nothing below is inferred from documentation; every "existing implementation" row was
read in source and, where it touches data, verified against `information_schema` and
live rows.

## 0. What exists today

| Area | File | Lines |
| --- | --- | --- |
| Schema | `backend/src/database/migrations/20260718000001_iot_telemetry.js` | 197 |
| Ingest (device-token) | `backend/src/modules/iot/routes/ingest.routes.js` | 193 |
| Fleet API (user-authed) | `backend/src/modules/iot/routes/devices.routes.js` | 272 |
| Alert → ticket | `backend/src/modules/iot/alertActions.js` | 86 |
| Monitor cron | `backend/src/jobs/iotMonitor.cron.js` | 90 |
| Risk score | `backend/src/modules/intelligence/ai.routes.js` (`/predict/device-failure`) | ~160 |
| Edge gateway | `edge-gateway/gateway.mjs` + `sources/{modbus,sim}.mjs` | 250 |
| UI | `frontend/src/features/iot/pages/FleetMonitor.jsx` | 1 page |
| Mount | `backend/server.js:783-784` | verified mounted |

Live data state (verified): `customer_equipment` = 5 rows, **all SEED placeholders**;
`device_telemetry` = 20 rows; `device_alerts` = 5 rows whose `state` column literally
holds **'Tamil Nadu'** and whose `severity` holds `Minor/Major/Critical` (the code writes
`info/warning/critical`); `device_alert_rules.operator` holds `'SEED ope'`. There were no
CHECK constraints on any of those columns, which is how the garbage got in — and because
`uq_device_alerts_open` is `WHERE state <> 'resolved'`, those five junk rows permanently
occupied the open-alert slot for equipment 37-41.

## 1. Defect → change map

| # | Area | Existing implementation | Defect | Required change | Files | DB | Tests |
|---|---|---|---|---|---|---|---|
| 1 | Tenant scope | `req.scope?.company_id ?? null`, then `if (companyId != null)` add predicate | Missing scope = **no company predicate = all tenants**. `req.scope` is `null` for any non-super user without a `user_scope` row | `iotScope(req)` → `{ companyId, isGlobal }`; **deny** when neither | `modules/iot/scope.js`, all routes | — | cross-company suite |
| 2 | Rule↔equipment | `POST /iot/rules` takes `equipment_id` unchecked | Company A can rule on Company B equipment; cron joins rule→equipment with no company equality | Validate ownership on write; add company equality to every join | `devices.routes.js`, `iotMonitor.cron.js`, `alertEngine.js` | FK + trigger-free check via app + `NOT VALID` CHECKs | rule ownership test |
| 3 | Credentials | hash + constant-time compare + rotate | No revoke/disable/expire/audit; rotation leaves no trace | `iot_device_tokens` lifecycle table; revoke/disable/enable endpoints; audit | `devices.routes.js`, migration | new table + `device_status` | token lifecycle test |
| 4 | Idempotency | identity is `(id, ts)` serial | Lost HTTP response → gateway resends → **duplicate samples** | `sample_uid`/`batch_uid`/`seq_no` + `UNIQUE(equipment_id, sample_uid, ts)` + batch ledger replay | `ingest.routes.js`, migration | unique idx + `iot_ingest_batches` | dedup + lost-response tests |
| 5 | Transaction | ticket INSERT inside ingest txn | A SQL error inside the txn aborts it; `catch` then runs more SQL on an aborted txn | Outbox: telemetry + event commit together, worker creates tickets | `ingest.routes.js`, `outbox.js`, `iotOutbox.cron.js` | `iot_outbox` | ticket-failure isolation test |
| 6 | Timestamps | one `ts` column, client-supplied | Sample dated 2000 or 2099 sets `last_seen_at`/`connection_state='online'` | `event_ts` vs `received_at`; skew policy; replay does not touch liveness/latest | `ingest.routes.js`, migration | `received_at`, `last_event_ts` | future/replay tests |
| 7 | Out-of-order | latest upsert has `WHERE device_latest.ts < EXCLUDED.ts` (correct) | but alert eval used batch-last only | keep guard; evaluate **event-ordered window** | `alertEngine.js` | — | out-of-order test |
| 8 | Quality | `quality SMALLINT` stored, never read | invalid data feeds AVG/alerts/trend | `quality_code` vocabulary + per-metric eligibility policy | migration, `ingest`, aggregation | `quality_code` | quality-exclusion test |
| 9 | Metric registry | none — free-text `VARCHAR(40)` | no units, no ranges, no capability | `iot_metric_definitions` seeded with the AHF/SVG/STATCOM contract | migration, `metrics.routes.js` | new table | range-rejection test |
| 10 | Device profiles | Modbus hardcoded big-endian, `addr % 10000 - 1` | wrong for most real devices | `iot_device_profiles` (byte/word order, addressing, scaling) + gateway honours it | migration, `sources/modbus.mjs` | new table | decode unit tests |
| 11 | Gateway flush | `flush()` re-entrant; `drop(n)` by count | overlapping flush double-sends / drops unacked | single-flight + IN_FLIGHT by id | `gateway.mjs` | — | overlap test |
| 12 | Spool | in-place rewrite; parse failure ⇒ `[]` | corrupt spool silently becomes empty queue | atomic tmp+rename, quarantine, dead-letter, backoff+jitter | `gateway.mjs` | — | corrupt-spool test |
| 13 | Alerts | one row per (equipment, rule), no state machine | no persistence/hysteresis/recovery/cooldown/suppression | full state machine + incident identity | `alertEngine.js`, migration | rule + alert columns, `iot_rule_state` | lifecycle suite |
| 14 | Live UI | one-shot fetch, no cancel | stale response overwrites newly selected device; API error renders as empty | polling + request-token race guard + explicit states | `FleetMonitor.jsx` | — | — |
| 15 | GPS | `Number(gps_lat)` guarded in map, **but** risk/KPI paths treat absent as usable | never render 0,0 | `FleetMonitor.jsx` | — | — |
| 16 | Fleet KPIs | computed from a `LIMIT 500`, search-filtered list | company totals wrong whenever a filter is typed | dedicated `/iot/fleet/summary` aggregate | `fleet.routes.js` | — | — |
| 17 | Risk | labelled "failure probability"; no data ⇒ score 0 ⇒ "No action needed" | false confidence | Condition Risk Score + `INSUFFICIENT_DATA` | `ai.routes.js`, `risk.js` | — | insufficient-data test |
| 18 | Rules UI | CRUD API with **no caller** | operators cannot manage rules | `AlertRules.jsx` | new page | — | — |
| 19 | Alert centre | none | no fleet-level triage | `AlertCenter.jsx` + filters API | new page | — | — |
| 20 | Retention | 3 months pre-created, DEFAULT partition catch-all | unbounded growth, default partition fills | partition roll + retention cron | `iotPartitions.cron.js` | — | — |
| 21 | Events | none | uptime/MTBF/MTTR not derivable | `iot_device_events` | migration | new table | — |
| 22 | Rate limit | global 300/min per **IP** | one site starves another | device/gateway-identity limiter | `ingest.routes.js` | — | — |
| 23 | Maintenance | none | service visit raises false offline alerts | `iot_maintenance_windows` + suppression | migration, engine | new table | suppression test |
| 24 | Notifications | alert row only | nobody is told | notification policy on rule + outbox worker | migration, worker | rule columns | — |
