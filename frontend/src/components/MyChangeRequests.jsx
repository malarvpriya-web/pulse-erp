import { useState, useEffect } from 'react';
import api from '@/services/api/client';

/*
 * My Details → Overview, self view only (2026-11-11): the employee's own
 * "Request change" tickets and the answers HR / Finance gave
 * (GET /servicedesk/corrections/mine). Shown here rather than only in My
 * Tickets because not every role can open My Tickets. Nothing is rendered until
 * the employee has raised one.
 */
const fmt = v => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '');
const STATE = {
  Open: ['#ede9fe', '#6d28d9'], 'In Progress': ['#ede9fe', '#6d28d9'],
  Resolved: ['#dcfce7', '#15803d'], Closed: ['#f1f5f9', '#475569'],
};

export default function MyChangeRequests({ reload = 0 }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let live = true;
    api.get('/servicedesk/corrections/mine')
      .then(r => { if (live) setRows(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [reload]);
  if (!rows.length) return null;

  return (
    <div data-testid="my-change-requests" style={{ gridColumn: '1 / -1', background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#6B3FDB', marginBottom: 8 }}>My change requests</div>
      {rows.map(c => {
        const [bg, fg] = STATE[c.status] || STATE.Closed;
        const to = c.team === 'Finance' ? 'Finance' : 'HR';
        const label = c.status === 'Resolved' ? 'Corrected' : c.status === 'Closed' ? 'Declined' : `With ${to}`;
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid #f3f4f6' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                {c.title} <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: 11.5 }}>{c.ticket_number}</span>
              </div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                To {to} · raised {fmt(c.created_at)}{c.reply ? ` · ${c.reply}` : ''}
              </div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' }}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
