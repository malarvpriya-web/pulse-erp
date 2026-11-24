/**
 * Shared pieces of the Leaves pages (2026-11-23): the approval-chain badge and
 * the approval-history dialog, so All Leaves, Leave Approvals and My Leaves
 * show a leave's progress the same way.
 *
 * The chain is Manager (L1) → HR, with the department head (L2) in between
 * ONLY when the leave type has "Needs department head approval" ticked
 * (`l2_required`, returned on every application row).
 */
import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Clock } from 'lucide-react';
import api from '@/services/api/client';

export const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const TONE = {
  approved:  { bg: '#d1fae5', color: '#065f46' },
  rejected:  { bg: '#fee2e2', color: '#991b1b' },
  pending:   { bg: '#ede9fe', color: '#5b21b6' },
  waiting:   { bg: '#f3f4f6', color: '#9ca3af' },
  cancelled: { bg: '#f3f4f6', color: '#6b7280' },
};

export function StatusChip({ status }) {
  const s = String(status || 'pending').toLowerCase();
  const t = TONE[s] || TONE.pending;
  return (
    <span style={{ background: t.bg, color: t.color, padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}

/** The steps this leave goes through, with the state of each. */
export function chainSteps(leave) {
  const status = String(leave.status || 'pending').toLowerCase();
  const mgr = String(leave.manager_status || 'pending').toLowerCase();
  const l2  = leave.l2_status ? String(leave.l2_status).toLowerCase() : null;
  const hr  = String(leave.hr_status || 'pending').toLowerCase();
  const steps = [{ key: 'L1', title: 'Manager', state: mgr }];
  if (leave.l2_required) steps.push({ key: 'L2', title: 'Department head', state: l2 || 'pending' });
  steps.push({ key: 'HR', title: 'HR', state: hr });
  // A step after a rejection, or after the request was cancelled, never happens.
  let stopped = false;
  return steps.map(s => {
    if (stopped) return { ...s, state: 'waiting' };
    if (s.state === 'rejected') stopped = true;
    if (status === 'cancelled' && s.state === 'pending') { stopped = true; return { ...s, state: 'waiting' }; }
    return s;
  }).map((s, i, all) => (
    // Only the first open step is "pending"; the ones after it are still waiting.
    s.state === 'pending' && all.slice(0, i).some(p => p.state === 'pending') ? { ...s, state: 'waiting' } : s
  ));
}

export function ApprovalChain({ leave }) {
  if (String(leave.status).toLowerCase() === 'cancelled') return <StatusChip status="cancelled" />;
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      {chainSteps(leave).map((s, i) => {
        const t = TONE[s.state] || TONE.pending;
        const mark = s.state === 'approved' ? ' ✓' : s.state === 'rejected' ? ' ✗' : '';
        return (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {i > 0 && <span style={{ color: '#d1d5db', fontSize: 11 }}>→</span>}
            <span title={`${s.title}: ${s.state}`}
              style={{ background: t.bg, color: t.color, padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {s.key}{mark}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const LEVEL = { 1: 'Manager', 2: 'Department head', 3: 'HR', 0: 'Employee / system' };

/** Centered dialog with the leave's decision trail and every comment. */
export function LeaveHistoryDialog({ leaveId, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api.get(`/leaves/applications/${leaveId}/history`)
      .then(r => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [leaveId]);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onClose}>
      <div style={{ width: 440, maxWidth: '100%', maxHeight: 'calc(100vh - 48px)', borderRadius: 12, background: '#fff', boxShadow: '0 20px 60px rgba(0,0,0,.18)', overflow: 'auto', padding: 24 }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1f2937' }}>Approval history</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 20 }}>×</button>
        </div>
        {loading ? <div style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>Loading…</div>
          : rows.length === 0 ? <div style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>No decision yet — the request is waiting for its first approver.</div>
          : rows.map((h, i) => {
            const col = h.action === 'approved' ? '#10b981' : h.action === 'rejected' ? '#ef4444' : '#6b7280';
            return (
              <div key={h.id || i} style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: col + '22', border: `2px solid ${col}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {h.action === 'approved' ? <CheckCircle size={13} color={col} /> : h.action === 'rejected' ? <XCircle size={13} color={col} /> : <Clock size={13} color={col} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: '#1f2937' }}>{LEVEL[h.approval_level] || `Level ${h.approval_level}`} · {h.action}</span>
                    <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmtDate(h.created_at)}</span>
                  </div>
                  {h.approver_name && <div style={{ fontSize: 12, color: '#6b7280' }}>by {h.approver_name}{h.approver_designation ? ` · ${h.approver_designation}` : ''}</div>}
                  {h.comments && <div style={{ marginTop: 6, padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 12, color: '#374151', borderLeft: '3px solid #e5e7eb' }}>{h.comments}</div>}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

/** RFC-4180 CSV (quotes, commas and line breaks escaped) and download. */
export function downloadCsv(filename, columns, rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [columns.map(c => cell(c.label)).join(','),
    ...rows.map(r => columns.map(c => cell(c.value ? c.value(r) : r[c.key])).join(','))].join('\r\n');
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Open a leave's attachment. A local file (/uploads/<name>) is served only by
 * GET /files/<name>, which needs the login token — a plain link sends none —
 * so it is fetched and shown from a blob. A storage-bucket https URL opens
 * directly. (2026-11-24)
 */
export async function openLeaveAttachment(url) {
  if (!url) return;
  if (/^https?:\/\//i.test(url)) { window.open(url, '_blank', 'noopener'); return; }
  const name = String(url).split('/').pop();
  const tab = window.open('', '_blank');   // opened now, inside the click, so it is not blocked
  try {
    const res = await api.get(`/files/${encodeURIComponent(name)}`, { params: { disposition: 'inline' }, responseType: 'blob' });
    const href = URL.createObjectURL(res.data);
    if (tab) tab.location.href = href; else window.open(href, '_blank');
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  } catch (e) {
    if (tab) tab.close();
    const status = e?.response?.status;
    window.alert(status === 403 ? 'You are not allowed to open this attachment.'
      : status === 404 ? 'The attachment file is missing. Ask the employee to attach it again.'
      : 'Could not open the attachment.');
  }
}

export function AttachmentLink({ url, label = 'Attachment', style }) {
  if (!url) return null;
  return (
    <button type="button" onClick={() => openLeaveAttachment(url)}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: '#6B3FDB', textDecoration: 'underline', ...style }}>
      {label}
    </button>
  );
}

/** Local calendar date (YYYY-MM-DD) — never toISOString(), which is a day behind in IST before 05:30. */
export const localISO = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
