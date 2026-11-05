# IoT API Contract

Every IoT endpoint, as implemented on 2026-09-15. Verified against the running
server, not against documentation.

**Base paths:** both `/api/v1/iot/...` and `/api/iot/...` resolve (server.js mounts
`v1Router` at each).

## Universal rules

| Rule | Behaviour |
| --- | --- |
| **Company scope** | Every user-authed endpoint calls `iotScope(req)`. A caller with no company scope and no explicit global (super-admin) scope gets **403 `NO_COMPANY_SCOPE`**. There is no code path where a missing scope widens access. |
| **Permission** | `requirePermission('iot', <action>)` against the role matrix. `perm === null` fails CLOSED. |
| **Resource ownership** | Device-addressed routes resolve through `scopedEquipment()`, which adds the company predicate. An out-of-scope id returns **404**, not 403 — a 403 would confirm the row exists in another tenant. |
| **Error semantics** | Handlers return a message, never a fabricated empty result. 4xx carries a `code`. 5xx on ingest carries `retryable: true`. |
| **Audit** | Mutations pass through `auditMutations('iot')`; provisioning, token lifecycle, rules, maintenance and exports also call `logAudit` explicitly with a before-image. |

## Device-facing (device token, no user session)

| Endpoint | Auth | Idempotent | Transaction | Notes |
| --- | --- | --- | --- | --- |
| `POST /iot/ingest` | `X-Device-Token`, SHA-256 hashed, constant-time compare | **Yes** — `batch_uid` replays the original response; `(equipment_id, sample_uid, ts)` is a unique index | One transaction: telemetry + latest cache + liveness + alert rows + outbox event. Ticket creation is NOT in it | Rate limit: per-device 120/min (`IOT_DEVICE_RL_MAX`), applied AFTER the token is verified. **Excluded from the IP-keyed global limiter**, which is a site limit one gateway can exhaust for its neighbours (`IOT_INGEST_SHARE_GLOBAL_RL=true` restores the old behaviour) |
| `POST /iot/gateway/heartbeat` | same | Upsert on `gateway_uid` | Single statement | Reports queue depth, spool size, disk free, errors, dead-letters, actual poll interval |

### `POST /iot/ingest` request

```jsonc
{
  "device_uid":  "PULSE-42-AB12CD",     // required
  "gateway_uid": "GW-BLR-PLANT1-01",    // optional, recommended
  "batch_uid":   "b-<stable hash>",     // optional; WITHOUT it batch replay cannot dedupe
  "samples": [{
    "sample_uid": "GW-1-41201-a3f2",    // optional; defaults to <batch_uid>:<index>
    "seq_no":     41201,                // optional
    "metric":     "THD_I_L1",           // REQUIRED, must exist in the metric registry
    "value":      4.2,                  // must be inside the metric's declared range
    "event_ts":   "2026-09-14T10:00:00Z",
    "quality":    "VALID"               // VALID | SUSPECT | INVALID | STALE | COMMUNICATION_ERROR
  }]
}
```

### `POST /iot/ingest` responses

| Status | Meaning | Gateway should |
| --- | --- | --- |
| `200` | Accepted. Body: `accepted`, `duplicates`, `rejected`, `alerts_opened`, `alerts_resolved`, `suppressed`, `idempotent`, `reasons` | Remove the batch from the spool |
| `200` + `replayed: true` | This `batch_uid` was already processed; the ORIGINAL response is returned | Remove the batch — it is committed |
| `401` | Unknown device or bad token (indistinguishable on purpose) | Hold data, alert the operator, back off |
| `403` `DEVICE_REVOKED` / `DEVICE_DISABLED` / `TOKEN_REVOKED` / `TOKEN_EXPIRED` | Credential lifecycle stop | Hold data, do not retry blindly |
| `413` | Batch over `IOT_MAX_BATCH` (5,000) | Split the batch |
| `422` | Every sample failed validation. `reasons` gives counts per reason | **Dead-letter the batch** — retrying will never succeed |
| `429` | Rate limited, `Retry-After` set | Honour `Retry-After` |
| `500` + `retryable: true` | Server or database failure; nothing committed | Retry with the same `batch_uid` |

### Rejection reasons (`reasons` map / `iot_rejected_samples.reason`)

`NO_METRIC` · `BAD_TIMESTAMP` · `FUTURE_TIMESTAMP` · `TOO_OLD` · `UNKNOWN_METRIC` ·
`METRIC_DISABLED` · `NOT_SUPPORTED_BY_PROFILE` · `NOT_NUMERIC` · `OUT_OF_RANGE` ·
`QUALITY_<code>`

### Timestamp policy

| Condition | Outcome |
| --- | --- |
| `event_ts` more than `IOT_MAX_FUTURE_SKEW_SECS` (120) ahead of server time | **Rejected**, quarantined `FUTURE_TIMESTAMP`. Cannot touch liveness. |
| `event_ts` older than `IOT_REPLAY_AFTER_SECS` (3600) | Accepted, quality forced to `REPLAY`. Stored in history. **Excluded** from the latest-value cache, from liveness and from alert evaluation. |
| `event_ts` older than `IOT_MAX_AGE_DAYS` (30) | **Rejected**, quarantined `TOO_OLD`. |
| Otherwise | Accepted at its declared quality. |

Liveness (`last_seen_at`, `connection_state`) is driven by **`received_at`** — the
server clock — never by the device's own stamp. `last_event_ts` records the
device's view separately.

## Operator-facing (user JWT)

### Fleet and devices

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/iot/fleet/summary` | `view` | **Whole-population aggregate.** Filters never change it. Includes `invalid_state_rows`. |
| GET | `/iot/devices` | `view` | Paged (`limit` ≤ 500, `offset`), filters `search` `state` `severity` `provisioned`. Returns `{rows, total, limit, offset, note}`. The `note` warns against deriving KPIs from it. |
| GET | `/iot/devices/:id` | `view` | Device 360: registry, connection truth, latest values with units and quality, alerts with ticket + technician, profile, gateway, maintenance windows, customer/project/AMC links, recent events |
| GET | `/iot/devices/:id/telemetry` | `view` | `metric` (required), `hours` 1–2160, `quality` policy. Returns points, **gaps**, `sample_count`, `valid_count`, `quality_mix`, `coverage` (with formula), `state` |
| GET | `/iot/devices/:id/risk` | `view` | Condition Risk Score with drivers and evidence; `state: INSUFFICIENT_DATA` when there is nothing to judge |
| GET | `/iot/devices/:id/power-quality` | `view` | Energy deltas (reset/rollover-aware), energy-weighted PF, unbalance, harmonic reduction, utilisation — each with its formula and state |
| GET | `/iot/devices/:id/events` | `view` | Connection / fault / service / maintenance history |

### Credential lifecycle

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/iot/devices/:id/provision` | `edit` | Mints `device_uid` + token. **Token returned once.** |
| POST | `/iot/devices/:id/rotate-token` | `edit` | Previous token → `rotated`. Exactly one `active` token per device (unique index). |
| POST | `/iot/devices/:id/revoke-token` | `edit` | Clears the equipment hash AND marks the token `revoked`. Ingest stops on the next request. |
| POST | `/iot/devices/:id/disable` / `/enable` | `edit` | `device_status` lifecycle; disable stops ingest |
| GET | `/iot/devices/:id/tokens` | `view` | History: prefix, status, who/when for create/rotate/revoke. **Never the secret.** |

### Alerts

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/iot/alerts` | `view` | Views: `open` `critical` `unassigned` `awaiting_service` `acknowledged` `resolved` `all`. Filters: severity, metric, equipment, customer, project, assigned_to, amc, from, to, search |
| GET | `/iot/alerts/:id` | `view` | Alert 360 + telemetry evidence + `allowed_transitions` + outbox delivery record |
| PUT | `/iot/alerts/:id/ack` | `edit` | **409 `ILLEGAL_TRANSITION`** with `allowed[]` if the state machine forbids it |
| PUT | `/iot/alerts/:id/resolve` | `edit` | Records `resolved_by`, `resolution_reason`, `resolution_source` |

### Rules

| Method | Path | Permission | Validation |
| --- | --- | --- | --- |
| GET | `/iot/rules` | `view` | Includes `live_alerts` per rule |
| POST | `/iot/rules` | `add` | Metric must exist in the registry; clear threshold must be on the correct side of the trigger; **403 `CROSS_COMPANY_EQUIPMENT`** if `equipment_id` is another tenant's (checked in app AND by composite FK) |
| PUT | `/iot/rules/:id` | `edit` | Same validation; a threshold change clears `iot_rule_state` so a stale breach timer cannot carry over |
| DELETE | `/iot/rules/:id` | `delete` | Open incidents survive |

### Maintenance, metrics, profiles

| Method | Path | Permission |
| --- | --- | --- |
| POST / GET | `/iot/devices/:id/maintenance` | `edit` / `view` |
| DELETE | `/iot/maintenance/:id` | `edit` |
| GET | `/iot/metrics` | `view` |
| GET | `/iot/profiles` | `view` |
| PUT | `/iot/devices/:id/profile` | `edit` |

### Operations

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/iot/ops/health` | `view` | Platform health + ratios with formulas + explicit caveats |
| GET | `/iot/ops/data-quality` | `view` | `group_by` device/metric/gateway; rejection reasons; deduplication counts |
| GET | `/iot/ops/gateways` | `view` | Per-gateway diagnostics with a derived `live_status` |
| GET | `/iot/ops/service-kpis` | `view` | MTTA / MTBF / MTTR / uptime, or `INSUFFICIENT_DATA` with the reason. Excludes rows outside the state vocabulary |
| GET | `/iot/ops/reconcile` | `view` | 14 integrity checks |
| POST | `/iot/ops/outbox/:id/replay` | `edit` | Requeue one dead-letter event |
| GET | `/iot/export/telemetry` | `export` | CSV; company-scoped; audited |
| GET | `/iot/export/alerts` | `export` | CSV; company-scoped; audited |

### Service parts, genealogy and the registry (added 2026-09-15)

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/iot/equipment/:id/genealogy` | `view` | As-built: serial master, batch, production order, serial history, service parts, lifetime cost. States plainly when a link cannot be made rather than returning an empty section |
| GET | `/iot/equipment/:id/service-parts` | `view` | Parts consumed on this unit, with the ids of the rows each issue created elsewhere |
| POST | `/iot/equipment/:id/service-parts` | `edit` | **The §74 chain in one call.** Writes a spare-parts issue, a stock-ledger line, a serial genealogy event, a balanced draft journal entry, a `PART_REPLACED` device event and the ticket's parts cost — atomically. Refuses `INSUFFICIENT_STOCK` (409) rather than going negative; refuses a ticket or alert from another company (403). Returns a `chain` object naming which links were made and `notes` for any that were not |
| POST | `/iot/service-parts/:id/reverse` | `edit` | Returns stock and posts the inverse. Does not delete the original record (409 `ALREADY_REVERSED` on a second attempt) |
| GET | `/iot/spare-parts` | `view` | Pickable spares with stock and a low-stock flag |
| GET | `/iot/notification-channels` | `view` | Which channels this deployment can deliver, with a reason for each that it cannot |
| GET | `/iot/alerts/:id/deliveries` | `view` | The delivery record per channel and recipient: `sent` / `failed` / `skipped` / `no_recipients` |
| POST · PUT · DELETE | `/iot/metrics[/:id]` | `add` · `edit` · `delete` | Tenant metric CRUD. A **global** catalogue row is read-only (403 `GLOBAL_METRIC_READONLY`) — a company creates an override with the same code. Delete refuses while rules or live metrics reference it (409 `METRIC_IN_USE`) |
| POST · PUT · DELETE | `/iot/profiles[/:id]` | `add` · `edit` · `delete` | Device profile CRUD **including the register map**. Shipped templates are read-only (403 `TEMPLATE_READONLY`). The register map is validated on save: unknown metric, duplicate metric, non-numeric address, unknown type and non-numeric scale are each refused by name |

### Hardware pilot evidence (added 2026-09-15)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/iot/pilot-evidence` | **device token** | Where `verify.mjs --post` lands. Creates a pilot in `in_progress` with the raw register bytes and all four decode variants. **Cannot create a passed pilot** — the tool has no standing to say a device reads correctly, only that it answered |
| POST | `/iot/pilots` | `add` | Open a pilot manually |
| GET | `/iot/pilots` | `view` | List, with per-pilot reading counts |
| GET | `/iot/pilots/status` | `view` | The certification question, answered from data. With no passed pilot the `statement` says every register map in the company is unverified |
| GET | `/iot/pilots/:id` | `view` | One pilot, its readings, and `blockers[]` — what still stands between it and a pass |
| PUT | `/iot/pilots/:id` | `edit` | Record the confirmed conventions, reference instrument and engineer. **409 `PILOT_CLOSED`** once completed |
| PUT | `/iot/pilots/:id/readings/:metric` | `edit` | One register's comparison. The difference and verdict are **computed** from pulse / display / reference / tolerance — **400 `NO_COMPARISON`** if `passed` is claimed without numbers that support it, quoting the actual difference |
| POST | `/iot/pilots/:id/complete` | `approve` | **409 `PILOT_INCOMPLETE`** listing every blocker unless a named engineer, a named reference instrument, all three confirmed conventions and at least one human comparison are present. A pass stamps the profile verified and corrects its conventions |

**Three layers enforce that a pilot cannot self-certify:** the UI disables the
button, the API returns 409 with the blockers, and a CHECK constraint on
`iot_hardware_pilots` refuses a `passed` row lacking the engineer, the reference
instrument or the confirmed conventions. A future route that forgets the check
still cannot write one.

### Financial posting

A part issue posts, as a **draft** journal entry (finance posts it, IoT does not
write into the ledger directly):

```
cover = warranty | amc        Dr 5052 Warranty Cost
cover = chargeable | goodwill Dr 5024 Repairs & Maintenance
                                  Cr 1034 Stores & Spares Inventory
```

Cover is derived from the equipment's own contract state unless a service manager
states it explicitly. If the chart of accounts lacks either code the issue still
succeeds and `notes` says no entry was created — the parts movement is not held
hostage to an accounting configuration.

## Frontend/backend contract check

| Page | Endpoints consumed | Shape |
| --- | --- | --- |
| FleetMonitor | `/iot/fleet/summary`, `/iot/devices`, `/iot/devices/:id`, `/iot/devices/:id/risk`, `/iot/devices/:id/telemetry`, provisioning routes | `{rows,total}` for the list, object for the rest. **No fallback to sample values anywhere** — a failure renders an error state |
| AlertCenter | `/iot/alerts`, `/iot/alerts/:id`, `/iot/metrics`, `/iot/export/alerts` | `{rows,total,view}` |
| AlertRules | `/iot/rules` (CRUD), `/iot/metrics`, `/iot/devices` | `{rows}` |
| IoTHealth | `/iot/ops/health`, `/iot/ops/data-quality`, `/iot/ops/gateways`, `/iot/ops/reconcile`, `/iot/ops/service-kpis` | objects |
| Equipment360 | `/iot/devices/:id`, `/iot/equipment/:id/genealogy`, `/iot/spare-parts`, `/iot/equipment/:id/service-parts`, `/iot/service-parts/:id/reverse` | objects |
| MetricRegistry | `/iot/metrics` + `/iot/profiles` (full CRUD) | `{rows}` / object |
| HardwarePilots | `/iot/pilots`, `/iot/pilots/status`, `/iot/pilots/:id`, `/iot/pilots/:id/readings/:metric`, `/iot/pilots/:id/complete` | `{rows}` / object |

Verified by `src/__tests__/iot.ingest.e2e.test.js`, which drives the real routers
over HTTP and asserts the response shapes the pages read, and by
`tests/suites/20-iot.spec.ts`, which drives the pages themselves in a browser —
including a case for each front-end defect this phase fixed (the late-response
race, an error rendering as empty data, and KPIs derived from a filtered list).
