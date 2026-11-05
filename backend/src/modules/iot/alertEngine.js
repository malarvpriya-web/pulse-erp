/**
 * alertEngine.js — the industrial alert state machine.
 *
 * WHAT IT REPLACES
 * ----------------
 * The Phase-1 engine was: take the LAST sample in the batch, compare it to the
 * threshold, and INSERT ... ON CONFLICT DO NOTHING. Four consequences, all
 * reproduced against the live database before this was written:
 *
 *  1. Intermediate breaches were invisible. A batch of 10:00=100, 10:01=180,
 *     10:02=105 against a threshold of 150 raised nothing, because only 10:02
 *     was examined. On a 60-second poll with a 5-minute flush that is four
 *     unexamined samples per batch; during a network outage it is hundreds.
 *  2. No persistence window, so a single noisy sample opened an incident.
 *  3. No clear threshold and no recovery, so an incident never closed by itself
 *     and a metric oscillating around the threshold produced an endless
 *     open/never-close stream.
 *  4. No cooldown and no maintenance suppression, so a planned service visit
 *     generated the alerts an engineer was standing next to the machine causing.
 *
 * THE STATE MACHINE
 * -----------------
 *   NORMAL ──breach observed──► (breach_since set)
 *      │
 *      └─ breach held for persistence_secs ──► ACTIVE          (incident opens)
 *
 *   ACTIVE ──operator──► ACKNOWLEDGED
 *   ACTIVE / ACKNOWLEDGED ──value clears clear_threshold──► RECOVERY_PENDING
 *   RECOVERY_PENDING ──clear held for recovery_secs──► RESOLVED  (cooldown starts)
 *   RECOVERY_PENDING ──breaches again──► back to its previous live state
 *   any live state ──maintenance window opens──► SUPPRESSED
 *
 *   A NEW breach after RESOLVED + cooldown is a NEW incident with a new
 *   incident_uid. That is what makes "one incident per condition" true without
 *   losing the second occurrence.
 *
 * HYSTERESIS
 *   trigger uses `threshold`; clearing uses `clear_threshold` when set. Between
 *   the two the state does not change — that band is the hysteresis, and it is
 *   what stops a metric sitting exactly on the limit from flapping. With no
 *   clear_threshold configured, clearing is simply "not breaching".
 *
 * EVALUATION IS EVENT-ORDERED
 *   Samples are processed in event-time order, not arrival order, so a late
 *   packet is evaluated at its own position in the timeline and cannot make the
 *   engine believe the condition recovered after it had already moved on.
 *
 * Every write here is company-scoped through the rule's own company_id, and
 * rules are only ever loaded with `rule.company_id = equipment.company_id`.
 */

import { enqueue } from './outbox.js';
import { QUALITY, eligibleCodes } from './quality.js';
import { recordEvent } from './deviceEvents.js';
import crypto from 'crypto';

export const ALERT_STATES = Object.freeze({
  PENDING_CONFIRMATION: 'pending_confirmation',
  ACTIVE: 'active',
  ACKNOWLEDGED: 'acknowledged',
  RECOVERY_PENDING: 'recovery_pending',
  RESOLVED: 'resolved',
  SUPPRESSED: 'suppressed',
});

const LIVE_STATES = [
  ALERT_STATES.PENDING_CONFIRMATION,
  ALERT_STATES.ACTIVE,
  ALERT_STATES.ACKNOWLEDGED,
  ALERT_STATES.RECOVERY_PENDING,
];

/**
 * Legal operator transitions. RESOLVED is terminal for an incident: an operator
 * cannot acknowledge something that is already closed, which the old
 * `UPDATE device_alerts SET state = 'acknowledged'` with no state predicate
 * happily allowed.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [ALERT_STATES.PENDING_CONFIRMATION]: [ALERT_STATES.ACTIVE, ALERT_STATES.ACKNOWLEDGED, ALERT_STATES.RESOLVED, ALERT_STATES.SUPPRESSED],
  [ALERT_STATES.ACTIVE]: [ALERT_STATES.ACKNOWLEDGED, ALERT_STATES.RECOVERY_PENDING, ALERT_STATES.RESOLVED, ALERT_STATES.SUPPRESSED],
  [ALERT_STATES.ACKNOWLEDGED]: [ALERT_STATES.RECOVERY_PENDING, ALERT_STATES.RESOLVED, ALERT_STATES.SUPPRESSED],
  [ALERT_STATES.RECOVERY_PENDING]: [ALERT_STATES.ACTIVE, ALERT_STATES.ACKNOWLEDGED, ALERT_STATES.RESOLVED, ALERT_STATES.SUPPRESSED],
  [ALERT_STATES.SUPPRESSED]: [ALERT_STATES.ACTIVE, ALERT_STATES.RESOLVED],
  [ALERT_STATES.RESOLVED]: [],
});

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

const OPS = {
  '>': (v, t) => v > t,
  '<': (v, t) => v < t,
  '>=': (v, t) => v >= t,
  '<=': (v, t) => v <= t,
  '=': (v, t) => v === t,
};

/** Does this sample clear the incident? Uses clear_threshold when configured. */
function clears(operator, value, threshold, clearThreshold) {
  if (clearThreshold == null) return !OPS[operator]?.(value, threshold);
  // For a rising rule (> / >=) the value must fall BELOW the clear threshold;
  // for a falling rule (< / <=) it must rise ABOVE it.
  if (operator === '>' || operator === '>=') return value < clearThreshold;
  if (operator === '<' || operator === '<=') return value > clearThreshold;
  return value !== threshold;
}

const secs = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const newIncidentUid = () => `INC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/**
 * Rules that apply to one device, with company equality enforced in the join.
 *
 * The old cron joined `r.equipment_id = ce.id` with NO company predicate, so a
 * rule in company A could fire against a device in company B whose id happened to
 * match. The composite FK added in 20260914000001 makes that impossible to
 * create; this predicate makes it impossible to evaluate even for rows that
 * predate the constraint.
 */
export async function loadRulesForDevice(db, { equipmentId, companyId, operatorIn = null }) {
  const params = [companyId, equipmentId];
  let opFilter = ` AND r.operator <> 'stale'`;
  if (operatorIn === 'stale') opFilter = ` AND r.operator = 'stale'`;
  const { rows } = await db.query(
    `SELECT r.*
       FROM device_alert_rules r
      WHERE r.is_active = TRUE
        AND r.company_id = $1
        AND (r.equipment_id = $2 OR r.equipment_id IS NULL)
        ${opFilter}
      ORDER BY r.id`,
    params,
  );
  return rows;
}

/** Is the device inside an open maintenance window right now? */
export async function inMaintenance(db, equipmentId, atIso = null) {
  const { rows } = await db.query(
    `SELECT id, reason, ends_at FROM iot_maintenance_windows
      WHERE equipment_id = $1
        AND cancelled_at IS NULL
        AND starts_at <= COALESCE($2::timestamptz, NOW())
        AND ends_at   >  COALESCE($2::timestamptz, NOW())
      ORDER BY ends_at DESC LIMIT 1`,
    [equipmentId, atIso],
  );
  return rows[0] || null;
}

/** Is the rule inside its configured active period (local server time)? */
function withinActivePeriod(rule, when) {
  if (!rule.active_from || !rule.active_to) return true;
  const hhmm = when.toTimeString().slice(0, 8);
  const from = String(rule.active_from), to = String(rule.active_to);
  return from <= to ? (hhmm >= from && hhmm <= to) : (hhmm >= from || hhmm <= to);
}

async function getRuleState(db, ruleId, equipmentId) {
  const { rows } = await db.query(
    `SELECT * FROM iot_rule_state WHERE rule_id = $1 AND equipment_id = $2 FOR UPDATE`,
    [ruleId, equipmentId],
  );
  return rows[0] || null;
}

async function putRuleState(db, s) {
  await db.query(
    `INSERT INTO iot_rule_state
       (rule_id, equipment_id, company_id, breach_since, clear_since, last_event_ts, last_value, cooldown_until, alert_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (rule_id, equipment_id) DO UPDATE
       SET breach_since   = EXCLUDED.breach_since,
           clear_since    = EXCLUDED.clear_since,
           last_event_ts  = EXCLUDED.last_event_ts,
           last_value     = EXCLUDED.last_value,
           cooldown_until = EXCLUDED.cooldown_until,
           alert_id       = EXCLUDED.alert_id,
           updated_at     = NOW()`,
    [s.rule_id, s.equipment_id, s.company_id, s.breach_since, s.clear_since,
     s.last_event_ts, s.last_value, s.cooldown_until, s.alert_id],
  );
}

async function liveAlertFor(db, equipmentId, ruleId) {
  const { rows } = await db.query(
    `SELECT * FROM device_alerts
      WHERE equipment_id = $1 AND rule_id = $2 AND state = ANY($3)
      ORDER BY opened_at DESC LIMIT 1`,
    [equipmentId, ruleId, LIVE_STATES],
  );
  return rows[0] || null;
}

/**
 * Evaluate one device's rules against an event-ordered window of samples.
 *
 * @param {object} db       transaction client (this runs inside the ingest txn —
 *                          the alert row and the outbox event commit together
 *                          with the telemetry that caused them)
 * @param {object} ctx      { equipmentId, companyId, equipment }
 * @param {Array}  samples  [{ metric, value, eventTs (ISO), quality }] in ANY
 *                          order; sorted here by event time
 * @returns {Promise<{opened: Array, resolved: Array, suppressed: number, evaluated: number}>}
 */
export async function evaluateWindow(db, { equipmentId, companyId, equipment }, samples) {
  const out = { opened: [], resolved: [], suppressed: 0, evaluated: 0 };
  if (!samples?.length) return out;

  const rules = await loadRulesForDevice(db, { equipmentId, companyId });
  if (!rules.length) return out;

  const maint = await inMaintenance(db, equipmentId);
  const now = new Date();

  for (const rule of rules) {
    const relevant = samples
      .filter((s) => s.metric === rule.metric && s.value != null)
      .filter((s) => eligibleCodes(rule.quality_policy).includes(s.quality))
      .sort((a, b) => new Date(a.eventTs) - new Date(b.eventTs));
    if (!relevant.length) continue;

    if (!withinActivePeriod(rule, now)) continue;

    let state = await getRuleState(db, rule.id, equipmentId) || {
      rule_id: rule.id, equipment_id: equipmentId, company_id: companyId,
      breach_since: null, clear_since: null, last_event_ts: null,
      last_value: null, cooldown_until: null, alert_id: null,
    };
    let alert = await liveAlertFor(db, equipmentId, rule.id);

    const threshold = rule.threshold == null ? null : Number(rule.threshold);
    const clearThr = rule.clear_threshold == null ? null : Number(rule.clear_threshold);
    if (threshold == null) continue;

    const persistence = secs(rule.persistence_secs);
    const recovery = secs(rule.recovery_secs);
    const cooldown = secs(rule.cooldown_secs);

    for (const s of relevant) {
      out.evaluated += 1;
      const value = Number(s.value);
      const eventTs = new Date(s.eventTs);

      // A sample older than one already evaluated for this rule cannot move the
      // machine forward — it is history arriving late. It is recorded (and kept
      // in the series) but does not rewrite a decision already taken.
      if (state.last_event_ts && eventTs < new Date(state.last_event_ts)) continue;

      const breaching = OPS[rule.operator]?.(value, threshold) === true;
      const clearing = clears(rule.operator, value, threshold, clearThr);

      if (breaching) {
        state.clear_since = null;
        if (!state.breach_since) state.breach_since = eventTs.toISOString();

        const heldSecs = (eventTs - new Date(state.breach_since)) / 1000;

        if (alert) {
          // Existing incident: extend it. A re-breach out of RECOVERY_PENDING
          // returns it to ACTIVE rather than opening a second incident.
          const nextState = alert.state === ALERT_STATES.RECOVERY_PENDING
            ? ALERT_STATES.ACTIVE
            : alert.state;
          const worst = alert.worst_value == null ? value
            : (rule.operator === '<' || rule.operator === '<=')
              ? Math.min(Number(alert.worst_value), value)
              : Math.max(Number(alert.worst_value), value);
          await db.query(
            `UPDATE device_alerts
                SET last_detected_at = GREATEST(COALESCE(last_detected_at, $2::timestamptz), $2::timestamptz),
                    breach_count = breach_count + 1,
                    observed_value = $3, worst_value = $4,
                    state = $5, recovery_since = NULL,
                    value = $3
              WHERE id = $1`,
            [alert.id, eventTs.toISOString(), value, worst, nextState],
          );
          alert.state = nextState;
        } else if (heldSecs >= persistence) {
          // Cooldown suppresses a re-open immediately after a resolution, so a
          // condition that recovers and re-breaches within the cooldown does not
          // produce a ticket storm.
          if (state.cooldown_until && now < new Date(state.cooldown_until)) continue;

          if (maint && rule.suppress_in_maintenance) {
            out.suppressed += 1;
            continue;
          }

          const incidentUid = newIncidentUid();
          const { rows } = await db.query(
            `INSERT INTO device_alerts
               (company_id, equipment_id, rule_id, metric, value, severity, state, message,
                incident_uid, first_detected_at, last_detected_at, breach_count,
                observed_value, worst_value, threshold, clear_threshold, unit, quality_code, opened_at)
             VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$9,1,$5,$5,$10,$11,$12,$13,$9)
             ON CONFLICT (equipment_id, rule_id)
               WHERE state IN ('pending_confirmation','active','acknowledged','recovery_pending')
               DO NOTHING
             RETURNING *`,
            [companyId, equipmentId, rule.id, rule.metric, value, rule.severity,
             `${rule.metric} ${rule.operator} ${threshold}${rule.unit ? ' ' + rule.unit : ''} (observed ${value})`,
             incidentUid, eventTs.toISOString(), threshold, clearThr, s.unit ?? null, s.quality],
          );
          if (rows.length) {
            alert = rows[0];
            state.alert_id = alert.id;
            out.opened.push(alert);
            await recordEvent(db, {
              companyId, equipmentId, eventType: 'FAULT', alertId: alert.id,
              source: 'alert_engine',
              detail: { rule_id: rule.id, metric: rule.metric, value, threshold, incident_uid: incidentUid },
            });
            await enqueue(db, {
              companyId,
              topic: 'alert.opened',
              dedupeKey: `alert.opened:${alert.id}`,
              payload: {
                alert_id: alert.id, incident_uid: incidentUid, rule_id: rule.id,
                equipment_id: equipmentId, company_id: companyId,
                metric: rule.metric, value, threshold, severity: rule.severity,
                create_ticket: rule.create_ticket !== false,
                notify_channels: rule.notify_channels || ['in_app'],
                notify_roles: rule.notify_roles || [],
                notify_user_ids: rule.notify_user_ids || [],
                equipment_name: equipment?.equipment_name ?? null,
              },
            });
          }
        }
      } else if (clearing && alert) {
        state.breach_since = null;
        if (!state.clear_since) state.clear_since = eventTs.toISOString();
        const clearedSecs = (eventTs - new Date(state.clear_since)) / 1000;

        if (alert.state !== ALERT_STATES.RECOVERY_PENDING && clearedSecs < recovery) {
          await db.query(
            `UPDATE device_alerts SET state = 'recovery_pending', recovery_since = $2 WHERE id = $1`,
            [alert.id, state.clear_since],
          );
          alert.state = ALERT_STATES.RECOVERY_PENDING;
        }

        if (clearedSecs >= recovery) {
          await db.query(
            `UPDATE device_alerts
                SET state = 'resolved', resolved_at = NOW(),
                    resolution_source = 'telemetry_recovery',
                    resolution_reason = $2,
                    observed_value = $3
              WHERE id = $1`,
            [alert.id,
             `${rule.metric} returned to ${clearThr != null ? 'below the clear threshold ' + clearThr : 'a non-breaching value'} (observed ${value})`,
             value],
          );
          await recordEvent(db, {
            companyId, equipmentId, eventType: 'RECOVERY', alertId: alert.id,
            source: 'alert_engine',
            detail: { rule_id: rule.id, metric: rule.metric, value, incident_uid: alert.incident_uid },
          });
          await enqueue(db, {
            companyId,
            topic: 'alert.resolved',
            dedupeKey: `alert.resolved:${alert.id}`,
            payload: {
              alert_id: alert.id, incident_uid: alert.incident_uid, equipment_id: equipmentId,
              company_id: companyId, metric: rule.metric, value, ticket_id: alert.ticket_id ?? null,
            },
          });
          out.resolved.push({ ...alert, state: ALERT_STATES.RESOLVED });
          alert = null;
          state.clear_since = null;
          state.alert_id = null;
          state.cooldown_until = cooldown > 0
            ? new Date(Date.now() + cooldown * 1000).toISOString()
            : null;
        }
      } else if (clearing) {
        // No live incident and the value is fine — just reset the breach timer.
        state.breach_since = null;
        state.clear_since = null;
      }
      // else: inside the hysteresis band — neither breaching nor clearing. The
      // machine deliberately does nothing.

      state.last_event_ts = eventTs.toISOString();
      state.last_value = value;
    }

    await putRuleState(db, state);
  }

  return out;
}

/**
 * Operator transition with the legality check the old handler lacked.
 *
 * `UPDATE device_alerts SET state='acknowledged' WHERE id=$1` would happily
 * acknowledge a resolved alert, or re-acknowledge one already acknowledged,
 * rewriting acknowledged_at each time.
 */
export async function transition(db, { alertId, companyId, toState, userId, reason, source = 'operator' }) {
  const { rows } = await db.query(
    `SELECT * FROM device_alerts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [alertId, companyId],
  );
  const alert = rows[0];
  if (!alert) return { ok: false, code: 'NOT_FOUND' };
  if (!canTransition(alert.state, toState)) {
    return { ok: false, code: 'ILLEGAL_TRANSITION', from: alert.state, to: toState };
  }

  const sets = [`state = $2`];
  const params = [alertId, toState];
  if (toState === ALERT_STATES.ACKNOWLEDGED) {
    params.push(userId ?? null);
    sets.push(`acknowledged_at = NOW()`, `acknowledged_by = $${params.length}`);
  }
  if (toState === ALERT_STATES.RESOLVED) {
    params.push(userId ?? null);
    sets.push(`resolved_at = NOW()`, `resolved_by = $${params.length}`);
    params.push(reason ?? null);
    sets.push(`resolution_reason = $${params.length}`);
    params.push(source);
    sets.push(`resolution_source = $${params.length}`);
  }
  const { rows: updated } = await db.query(
    `UPDATE device_alerts SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params,
  );

  if (toState === ALERT_STATES.RESOLVED) {
    await db.query(
      `UPDATE iot_rule_state SET alert_id = NULL, breach_since = NULL, clear_since = NULL, updated_at = NOW()
        WHERE equipment_id = $1 AND rule_id = $2`,
      [alert.equipment_id, alert.rule_id],
    );
  }
  return { ok: true, alert: updated[0] };
}

export { LIVE_STATES, QUALITY };
