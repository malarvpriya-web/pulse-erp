/**
 * procurement.stateMachine.js — which status may follow which.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every status write in this module validated the DESTINATION and nothing else.
 * `PUT /purchase-orders/:id/status` checked `VALID_PO_STATUSES.has(status)` and
 * then wrote it, so every one of these was a 200:
 *
 *   cancelled -> approved     resurrect an order somebody deliberately killed
 *   draft     -> received     mark goods received against an unapproved order
 *   received  -> draft        un-receive stock that is already in the warehouse
 *   completed -> sent         re-issue a closed order to the vendor
 *
 * The approve and cancel routes were worse: neither looked at the current status
 * at all. Approving an already-approved PO ran the whole handler again — a
 * second audit row, and a SECOND COPY OF THE PURCHASE ORDER EMAILED TO THE
 * VENDOR, which is how one order becomes two deliveries. Cancelling an order
 * that was already received left inventory booked against a cancelled document.
 *
 * A destination-only check is not validation, it is spell-checking. What makes a
 * transition legal is where the record is now.
 *
 * CONTRACT
 * --------
 * `assertTransition(kind, from, to)` returns null when the move is allowed and
 * `{ status, body }` when it is not, matching assertCanDecideAmount()'s shape so
 * routes handle both the same way. A no-op move (from === to) is reported
 * separately via `isNoop()` so callers can answer idempotently — a repeated
 * approve should return the record, not an error.
 */

/**
 * Purchase order lifecycle.
 *
 *   draft ──approve──► approved ──send──► sent ──receipt──► partial ──► received
 *     │                    │                │                 │            │
 *     └──────cancel────────┴────────────────┴─────────────────┘            │
 *                                                          invoiced ◄──────┘
 *                                                              └──► completed / closed
 *
 * 'received' is written by the GRN service, never by a person: the receipt is
 * what makes an order received. It is therefore absent from the operator-facing
 * transitions out of 'draft' and 'sent'.
 */
export const PO_TRANSITIONS = {
  draft:     ['approved', 'sent', 'cancelled'],
  approved:  ['sent', 'partial', 'received', 'cancelled'],
  sent:      ['partial', 'received', 'cancelled'],
  partial:   ['partial', 'received', 'cancelled', 'closed'],
  received:  ['partial', 'invoiced', 'completed', 'closed'],
  invoiced:  ['completed', 'closed'],
  // Terminal. A cancelled order is reopened by raising a new one, not by
  // rewriting the cancelled document's history.
  completed: [],
  closed:    [],
  cancelled: [],
};

/**
 * Purchase requisition lifecycle.
 * 'converted_to_po' is terminal: the requisition's demand now lives on the order.
 */
export const PR_TRANSITIONS = {
  draft:            ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved:         ['converted_to_po', 'cancelled'],
  rejected:         ['pending_approval', 'cancelled'],
  converted_to_po:  [],
  cancelled:        [],
};

/**
 * Goods receipt lifecycle — the vocabulary GoodsReceipt.jsx renders.
 * 'partial' means: confirmed, but its purchase order is still short.
 */
export const GRN_TRANSITIONS = {
  pending:   ['received', 'partial', 'rejected', 'cancelled'],
  partial:   ['received', 'rejected', 'cancelled'],
  received:  ['rejected'],
  rejected:  [],
  cancelled: [],
};

const MAPS = {
  purchase_order:   { label: 'purchase order', map: PO_TRANSITIONS },
  purchase_request: { label: 'purchase request', map: PR_TRANSITIONS },
  grn:              { label: 'goods receipt', map: GRN_TRANSITIONS },
};

/** Is this a request to move somewhere the record already is? */
export const isNoop = (from, to) => String(from ?? '') === String(to ?? '');

/** Every status the given document type recognises. */
export const statusesFor = (kind) => Object.keys(MAPS[kind]?.map ?? {});

/**
 * @returns {null | {status:number, body:object}} null when the move is allowed.
 */
export function assertTransition(kind, from, to) {
  const entry = MAPS[kind];
  if (!entry) throw new Error(`Unknown document kind: ${kind}`);
  const { label, map } = entry;

  if (!Object.prototype.hasOwnProperty.call(map, to)) {
    return { status: 400, body: {
      error: `'${to}' is not a ${label} status.`,
      code: 'INVALID_STATUS',
      allowed: Object.keys(map),
    } };
  }

  const current = String(from ?? '');
  // A record sitting in a status this machine does not know about (legacy data
  // that predates the vocabulary) is not silently frozen: it may move to any
  // recognised status once, which is how it rejoins the lifecycle.
  if (!Object.prototype.hasOwnProperty.call(map, current)) return null;

  if (isNoop(current, to)) return null;

  if (!map[current].includes(to)) {
    const onward = map[current];
    return { status: 409, body: {
      error: onward.length
        ? `A ${label} that is '${current}' cannot become '${to}'. From here it can only move to: ${onward.join(', ')}.`
        : `This ${label} is '${current}', which is final — it cannot be changed.`,
      code: 'INVALID_STATUS_TRANSITION',
      from: current,
      to,
      allowed: onward,
    } };
  }
  return null;
}

export default { assertTransition, isNoop, statusesFor, PO_TRANSITIONS, PR_TRANSITIONS, GRN_TRANSITIONS };
