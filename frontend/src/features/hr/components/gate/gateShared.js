// Shared pieces for Gate Pass & Visitors (pages/GatePassVisitors.jsx, the
// register) and My Gate Passes (pages/MyGatePasses.jsx, self-service).
// Backend: hr/gateAccess.routes.js — MODULE_FEATURE_CONNECTION_MANUAL.md §272.
import api from '@/services/api/client';
import { fmtStamp, esc, printDocument } from '../biometric/biometricShared';

// Effective status, as the server computes it (stored status + the clock).
export const PASS_STATUS = {
  pending:   { label: 'Pending approval', color: '#6d28d9' },
  approved:  { label: 'Approved',         color: '#2563eb' },
  out:       { label: 'Out',              color: '#d97706' },
  overdue:   { label: 'Overdue',          color: '#dc2626' },
  expired:   { label: 'Expired',          color: '#6b7280' },
  completed: { label: 'Completed',        color: '#0f766e' },
  cancelled: { label: 'Cancelled',        color: '#9ca3af' },
};
export const PASS_STATUS_ORDER = ['pending', 'approved', 'out', 'overdue', 'expired', 'completed', 'cancelled'];

export const CATEGORIES = [
  ['official', 'Official work'],
  ['personal', 'Personal'],
  ['medical', 'Medical'],
  ['other', 'Other'],
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);

// §273: security approves entry before check-in.
export const VISITOR_STATUS = {
  pending_approval: { label: 'Awaiting security', color: '#6d28d9' },
  approved:    { label: 'Approved — not arrived', color: '#2563eb' },
  inside:      { label: 'Inside',      color: '#16a34a' },
  no_show:     { label: 'No-show',     color: '#9ca3af' },
  checked_out: { label: 'Checked out', color: '#6b7280' },
  rejected:    { label: 'Entry refused', color: '#dc2626' },
  cancelled:   { label: 'Cancelled',   color: '#9ca3af' },
};

export const ID_TYPES = ['Aadhaar', 'PAN', 'Passport', 'Driving Licence', 'Voter ID', 'Other'];
export const ID_HINT = {
  Aadhaar: '12 digits', PAN: 'e.g. ABCDE1234F', Passport: 'a letter and 7 digits',
  'Driving Licence': '8–20 letters or digits', 'Voter ID': 'e.g. ABC1234567', Other: '4–30 letters or digits',
};

/** What a stored event means, in words. */
export const EVENT_LABEL = {
  created: 'Requested', edited: 'Edited', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn',
  cancelled: 'Cancelled', out: 'Went out', dispatched: 'Goods dispatched', returned: 'Back in',
  items_returned: 'Items returned', all_returned: 'All items returned', closed: 'Closed',
  pre_registered: 'Pre-registered', registered: 'Registered at the gate', entry_approved: 'Entry approved by security',
  entry_rejected: 'Entry refused by security', goods_pass: 'Goods pass raised', checked_in: 'Checked in', checked_out: 'Checked out',
  badge_printed: 'Badge printed', badge_reprinted: 'Badge reprinted', photo_added: 'Photo added', photo_replaced: 'Photo replaced',
};

/** ISO → the value a datetime-local input takes, in the browser's zone. */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** datetime-local value → ISO with the browser's offset ('' stays ''). */
export const toIso = (local) => (local ? new Date(local).toISOString() : '');

/** Now + `hours`, as a datetime-local value. */
export const localIn = (hours) => toLocalInput(new Date(Date.now() + hours * 3600_000).toISOString());

export const fmtQty = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 }));

export function passTypeLabel(gp) {
  if (gp.pass_type !== 'material') return CATEGORY_LABEL[gp.category] || 'Gate pass';
  return gp.returnable ? 'Returnable goods' : 'Non-returnable goods';
}

/** GET a CSV and save it. Returns an error message or null. */
export async function downloadCsv(path, params, fallbackName) {
  try {
    const res = await api.get(path, { params, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    const cd = res.headers?.['content-disposition'] || '';
    a.href = url;
    a.download = /filename="?([^"]+)"?/.exec(cd)?.[1] || fallbackName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return null;
  } catch (err) {
    if (err?.response?.data instanceof Blob) {
      try { return JSON.parse(await err.response.data.text()).message || 'Export failed'; } catch { /* fall through */ }
    }
    return err?.response?.data?.message || 'Export failed';
  }
}

/** Print one pass in its own window. Returns false when pop-ups are blocked. */
export function printPass(gp, items = []) {
  const st = PASS_STATUS[gp.effective_status] || { label: gp.effective_status };
  const live = ['approved', 'out', 'overdue'].includes(gp.effective_status);
  const row = (k, v) => (v ? `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>` : '');
  const who = `${gp.employee_name || gp.visitor_name || '—'}${gp.emp_code ? ` (${gp.emp_code})` : ''}`;
  const material = gp.pass_type === 'material';
  const goods = material && items.length ? `
      <h2 style="font-size:15px;margin:16px 0 6px;color:#4c1d95">Goods</h2>
      <table class="grid"><thead><tr><th>#</th><th>Item</th><th>Code</th><th style="text-align:right">Qty</th><th>Unit</th>${gp.returnable ? '<th style="text-align:right">Returned</th>' : ''}</tr></thead>
      <tbody>${items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.description)}${it.remarks ? `<div class="muted">${esc(it.remarks)}</div>` : ''}</td>
        <td>${esc(it.item_code || '')}</td><td style="text-align:right">${esc(fmtQty(it.quantity))}</td><td>${esc(it.unit)}</td>
        ${gp.returnable ? `<td style="text-align:right">${esc(fmtQty(it.returned_quantity))}</td>` : ''}</tr>`).join('')}</tbody></table>` : '';
  return printDocument(`${material ? 'Material Gate Pass' : 'Gate Pass'} ${gp.pass_number}`, `
    <style>.grid{border-collapse:collapse;width:100%;font-size:13px}.grid th,.grid td{border:1px solid #e5e7eb;padding:5px 6px;text-align:left}
      .grid th{background:#f5f3ff;color:#4c1d95}.muted{color:#6b7280;font-size:11px}.card{max-width:680px}</style>
    <div class="card">
      <h1>${material ? `Material Gate Pass — ${gp.returnable ? 'Returnable (RGP)' : 'Non-returnable (NRGP)'}` : 'Gate Pass'} ${esc(gp.pass_number)}</h1>
      <div class="sub">Requested ${esc(fmtStamp(gp.created_at))}${gp.approved_at ? ` · approved ${esc(fmtStamp(gp.approved_at))}` : ''}</div>
      <table>
        ${row(material ? 'Responsible employee' : 'Issued to', who)}
        ${row('Department', gp.department)}
        ${row('Type', passTypeLabel(gp))}
        ${row(material ? 'Purpose' : 'Reason', gp.purpose)}
        ${row('Destination', gp.destination)}
        ${row('Vehicle', gp.vehicle_number)}
        ${row('Carried by', gp.carried_by)}
        ${row('Valid from', gp.valid_from ? fmtStamp(gp.valid_from) : material ? '' : 'Open')}
        ${row(material ? 'Valid until' : 'Due back', gp.valid_to ? fmtStamp(gp.valid_to) : '')}
        ${row('Due back', material && gp.expected_return_at ? fmtStamp(gp.expected_return_at) : '')}
        ${row('Approved by', gp.approved_by_name)}
        ${row('Went out', gp.out_at ? `${fmtStamp(gp.out_at)}${gp.out_by_name ? ` · ${gp.out_by_name}` : ''}` : '')}
        ${row('Came back', gp.in_at ? `${fmtStamp(gp.in_at)}${gp.in_by_name ? ` · ${gp.in_by_name}` : ''}` : '')}
        ${row('Closed', gp.close_reason)}
      </table>
      ${goods}
      <span class="stamp ${live ? 'ok' : 'bad'}">${esc(st.label.toUpperCase())}</span>
      <div class="sign"><span>${material ? 'Prepared by' : 'Employee'}</span><span>Approved by</span><span>Security (out)</span><span>Security (in)</span></div>
    </div>`);
}

export function printBadge(v) {
  const row = (k, val) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`;
  return printDocument(`Visitor pass ${v.pass_number || v.name}`, `
    <div class="card">
      <h1>VISITOR GATE PASS${v.pass_number ? ` ${esc(v.pass_number)}` : ''}</h1>
      <div class="sub">Checked in ${esc(fmtStamp(v.check_in_time))}${v.approved_by_name ? ` · entry approved by ${esc(v.approved_by_name)}` : ''}</div>
      <table>
        ${row('Name', v.name)}
        ${row('Company', v.company || '—')}
        ${row('People', String(v.visitor_count || 1))}
        ${row('Host', v.host_name || '—')}
        ${row('Purpose', v.purpose || '—')}
        ${v.vehicle_number ? row('Vehicle', v.vehicle_number) : ''}
      </table>
      <span class="stamp ok">VALID ${esc(fmtStamp(v.check_in_time, { time: false }).toUpperCase())} ONLY</span>
      <div class="sign"><span>Return this badge at check-out</span><span>Security</span></div>
    </div>`);
}
