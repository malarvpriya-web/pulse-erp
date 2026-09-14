/**
 * dealRegistration.service.js
 *
 * The rules of partner deal registration, kept out of the routes so they can be
 * tested without a request and so the same rule cannot be enforced two
 * different ways in two different handlers.
 */

/**
 * Legal transitions. `submitted` is the only state a partner can create.
 *
 * `expired` is reachable from `approved` only — a registration that was never
 * approved has no protection to lose. `converted` is terminal on the CRM side
 * but keeps its outcome (`won`/`lost`) as a separate field, because "this became
 * an opportunity" and "that opportunity was won" are different facts and
 * collapsing them into one status is how commission disputes start.
 */
export const TRANSITIONS = {
  submitted: ['approved', 'rejected', 'withdrawn'],
  approved:  ['converted', 'expired', 'lost', 'withdrawn'],
  rejected:  ['submitted', 'withdrawn'],
  expired:   ['submitted'],
  converted: ['lost'],
  lost:      [],
  withdrawn: ['submitted'],
};

export const APPROVAL_ROLES = ['super_admin', 'admin', 'sales_manager', 'channel_manager'];

export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/** Normalised customer key — the same normalisation the unique index uses. */
export const customerKey = (name) => String(name || '').trim().toLowerCase();

/**
 * When protection ends.
 *
 * Measured from approval, not from submission: a registration that sat in a
 * queue for three weeks should still get its full window, otherwise a slow
 * reviewer silently shortens the partner's protection.
 */
export function expiryFrom(approvedAt, protectionDays) {
  const days = Number(protectionDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(new Date(approvedAt).getTime() + days * 86400000);
}

/**
 * Does this claim collide with a live registration?
 *
 * Returns the conflicting row, or null. Case- and whitespace-insensitive on the
 * customer name, because "Acme Corp" and "acme corp " are the same customer and
 * a partner typing the second one must not get a second protection window.
 */
export async function findConflict(pool, { companyId, customerName, excludeId = null }) {
  const { rows } = await pool.query(
    `SELECT r.id, r.registration_number, r.partner_id, r.customer_name,
            r.approved_at, r.expires_at, p.name AS partner_name
       FROM partner_deal_registrations r
       JOIN sales_partners p ON p.id = r.partner_id
      WHERE r.company_id = $1
        AND r.status = 'approved'
        AND LOWER(TRIM(r.customer_name)) = $2
        AND ($3::int IS NULL OR r.id <> $3)
      LIMIT 1`,
    [companyId, customerKey(customerName), excludeId]
  );
  return rows[0] || null;
}

/**
 * Expire approved registrations whose window has passed.
 *
 * Returns the rows it expired. Run on a schedule AND before any conflict check:
 * an expired-but-not-yet-swept registration would otherwise block a new
 * registration that should be allowed, which is a silent commercial refusal.
 */
export async function expireLapsed(pool, { companyId = null, now = new Date() } = {}) {
  const { rows } = await pool.query(
    `UPDATE partner_deal_registrations
        SET status = 'expired', outcome = 'expired', updated_at = NOW()
      WHERE status = 'approved'
        AND expires_at IS NOT NULL
        AND expires_at <= $1
        AND ($2::int IS NULL OR company_id = $2)
      RETURNING id, company_id, partner_id, customer_name, expires_at`,
    [now, companyId]
  );
  for (const r of rows) {
    await pool.query(
      `INSERT INTO partner_deal_registration_events (registration_id, company_id, event, detail)
       VALUES ($1,$2,'expired',$3)`,
      [r.id, r.company_id, `Protection window ended ${new Date(r.expires_at).toISOString().slice(0, 10)}`]
    );
  }
  return rows;
}

/**
 * Approve a registration.
 *
 * Refuses self-approval, refuses an approver without the role, and refuses a
 * customer already protected by somebody else. The conflict check runs inside
 * the transaction and the unique index backs it — the check alone loses a race,
 * the index alone gives a constraint-violation error nobody can read.
 */
export async function approve(pool, { id, companyId, employeeId, roles = [], protectionDays, now = new Date() }) {
  await expireLapsed(pool, { companyId, now });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [reg] } = await client.query(
      `SELECT * FROM partner_deal_registrations
        WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]);
    if (!reg) { await client.query('ROLLBACK'); return { error: 'not_found' }; }

    if (!canTransition(reg.status, 'approved')) {
      await client.query('ROLLBACK');
      return { error: 'illegal_transition', from: reg.status, to: 'approved',
               allowed: TRANSITIONS[reg.status] || [] };
    }
    if (!roles.some(r => APPROVAL_ROLES.includes(String(r).toLowerCase()))) {
      await client.query('ROLLBACK');
      return { error: 'role_required', roles: APPROVAL_ROLES };
    }
    // The person who submitted a registration must not be the one who grants it
    // protection — the approval is the only independent check in the process.
    if (employeeId && reg.submitted_by && String(reg.submitted_by) === String(employeeId)) {
      await client.query('ROLLBACK');
      return { error: 'self_approval' };
    }

    const { rows: [conflict] } = await client.query(
      `SELECT r.id, r.registration_number, r.expires_at, p.name AS partner_name
         FROM partner_deal_registrations r
         JOIN sales_partners p ON p.id = r.partner_id
        WHERE r.company_id = $1 AND r.status = 'approved'
          AND LOWER(TRIM(r.customer_name)) = $2 AND r.id <> $3
        LIMIT 1`,
      [companyId, customerKey(reg.customer_name), id]);
    if (conflict) {
      await client.query('ROLLBACK');
      return { error: 'conflict', conflict };
    }

    const days = protectionDays ?? reg.protection_days;
    const expires = expiryFrom(now, days);
    const { rows: [updated] } = await client.query(
      `UPDATE partner_deal_registrations
          SET status = 'approved', approved_at = $2, approved_by = $3,
              protection_days = $4, expires_at = $5,
              rejected_reason = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, now, employeeId, days, expires]);

    await client.query(
      `INSERT INTO partner_deal_registration_events
         (registration_id, company_id, event, detail, actor_employee)
       VALUES ($1,$2,'approved',$3,$4)`,
      [id, companyId,
       `Protected until ${expires ? expires.toISOString().slice(0, 10) : 'n/a'} (${days} days)`,
       employeeId]);

    await client.query('COMMIT');
    return { registration: updated };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // The partial unique index is the last line of defence when two approvals
    // race. Translate it, rather than surfacing a raw constraint name.
    if (err.code === '23505' && String(err.constraint || '').includes('live_customer')) {
      return { error: 'conflict', conflict: null };
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Move a registration to any other legal state. Approval has its own function. */
export async function transition(pool, { id, companyId, to, employeeId, reason, roles = [] }) {
  if (to === 'approved') return approve(pool, { id, companyId, employeeId, roles });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [reg] } = await client.query(
      `SELECT * FROM partner_deal_registrations WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]);
    if (!reg) { await client.query('ROLLBACK'); return { error: 'not_found' }; }

    if (!canTransition(reg.status, to)) {
      await client.query('ROLLBACK');
      return { error: 'illegal_transition', from: reg.status, to,
               allowed: TRANSITIONS[reg.status] || [] };
    }
    if (to === 'rejected' && !roles.some(r => APPROVAL_ROLES.includes(String(r).toLowerCase()))) {
      await client.query('ROLLBACK');
      return { error: 'role_required', roles: APPROVAL_ROLES };
    }

    const sets = ['status = $2', 'updated_at = NOW()'];
    const params = [id, to];
    if (to === 'rejected') {
      params.push(reason || null);
      sets.push(`rejected_reason = $${params.length}`, 'approved_at = NULL', 'approved_by = NULL',
                'expires_at = NULL');
    }
    if (to === 'lost')      sets.push(`outcome = 'lost'`);
    if (to === 'submitted') sets.push('rejected_reason = NULL', 'approved_at = NULL',
                                      'approved_by = NULL', 'expires_at = NULL', 'outcome = NULL');
    if (to === 'withdrawn') sets.push('expires_at = NULL');

    const { rows: [updated] } = await client.query(
      `UPDATE partner_deal_registrations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params);

    await client.query(
      `INSERT INTO partner_deal_registration_events
         (registration_id, company_id, event, detail, actor_employee)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, companyId, to, reason || null, employeeId]);

    await client.query('COMMIT');
    return { registration: updated, from: reg.status, to };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Channel performance, per partner.
 *
 * ⚠ A partner with no registrations is UNMEASURED, not 0% win rate. The two are
 * indistinguishable in a naive `won / total` and treating them the same is the
 * mistake this codebase has made repeatedly (supplier on_time_pct, article
 * effectiveness). `win_rate` is NULL until something has actually closed.
 */
export async function partnerPerformance(pool, { companyId }) {
  const { rows } = await pool.query(
    `SELECT p.id AS partner_id, p.name AS partner_name, p.commission_pct, p.status AS partner_status,
            COUNT(r.id)::int                                            AS registrations,
            COUNT(r.id) FILTER (WHERE r.status = 'approved')::int       AS approved,
            COUNT(r.id) FILTER (WHERE r.status = 'submitted')::int      AS pending,
            COUNT(r.id) FILTER (WHERE r.status = 'rejected')::int       AS rejected,
            COUNT(r.id) FILTER (WHERE r.status = 'expired')::int        AS expired,
            COUNT(r.id) FILTER (WHERE r.status = 'converted')::int      AS converted,
            COUNT(r.id) FILTER (WHERE r.outcome = 'won')::int           AS won,
            COUNT(r.id) FILTER (WHERE r.outcome = 'lost')::int          AS lost,
            COALESCE(SUM(r.estimated_value) FILTER (WHERE r.status IN ('approved','converted')), 0) AS protected_value,
            CASE WHEN COUNT(r.id) FILTER (WHERE r.outcome IN ('won','lost')) = 0 THEN NULL
                 ELSE ROUND(100.0 * COUNT(r.id) FILTER (WHERE r.outcome = 'won')
                            / COUNT(r.id) FILTER (WHERE r.outcome IN ('won','lost')), 1)
            END AS win_rate
       FROM sales_partners p
       LEFT JOIN partner_deal_registrations r
              ON r.partner_id = p.id AND r.company_id = $1
      WHERE (p.company_id = $1 OR p.company_id IS NULL) AND p.deleted_at IS NULL
      GROUP BY p.id, p.name, p.commission_pct, p.status
      ORDER BY registrations DESC, p.name`,
    [companyId]
  );
  // pg returns numeric as a string; a win_rate of "50.0" turns any arithmetic
  // upstream into string concatenation.
  return rows.map(r => ({
    ...r,
    win_rate: r.win_rate === null ? null : Number(r.win_rate),
    protected_value: Number(r.protected_value),
    measured: Number(r.won) + Number(r.lost) > 0,
  }));
}
