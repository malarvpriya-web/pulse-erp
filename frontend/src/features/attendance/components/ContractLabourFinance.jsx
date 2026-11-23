// Contract Labour → Attendance → Send to Finance (§278.4, owner 2026-11-19).
// The month's contract-labour attendance per contractor (workers, man-days,
// hours) is saved as a statement and every Finance user is notified, for the
// contractors' bills. Sending a month again replaces its figures.
import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';

function lastMonths(n = 6) {
  const out = []; const d = new Date(); d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.push({ m: d.getMonth() + 1, y: d.getFullYear(), label: d.toLocaleString('en-GB', { month: 'long', year: 'numeric' }) });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export default function ContractLabourFinance({ canSend, flash }) {
  const opts = lastMonths();
  const [pick, setPick] = useState(`${opts[1].y}-${opts[1].m}`);   // last month by default
  const [sent, setSent] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [y, m] = pick.split('-').map(Number);

  const load = () => api.get(`/attendance/contract-labour/finance-statements?month=${m}&year=${y}`)
    .then((r) => setSent(r.data || [])).catch(() => setSent([]));
  useEffect(() => { load(); }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    setBusy(true); setErr('');
    try {
      const { data } = await api.post('/attendance/contract-labour/send-to-finance', { month: m, year: y });
      flash?.(`Sent to Finance — ${data.statements.length} contractor${data.statements.length === 1 ? '' : 's'}, ${data.finance_notified} Finance user${data.finance_notified === 1 ? '' : 's'} notified`);
      load();
    } catch (e) {
      setErr(e?.response?.data?.message || e?.response?.data?.error || 'Could not send');
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="cl-finance" style={{ background: '#fff', border: '1px solid #ece9f8', borderRadius: 12, padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>Send to Finance</span>
        <select aria-label="Month" value={pick} onChange={(e) => setPick(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}>
          {opts.map((o) => <option key={`${o.y}-${o.m}`} value={`${o.y}-${o.m}`}>{o.label}</option>)}
        </select>
        <span style={{ flex: 1, fontSize: 12, color: '#6b7280' }}>
          Man-days and hours per contractor, for their bill. {sent.length ? `Sent ${new Date(sent[0].sent_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}${sent[0].sent_by_name ? ` by ${sent[0].sent_by_name}` : ''}.` : 'Not sent yet.'}
        </span>
        {canSend && (
          <button onClick={send} disabled={busy}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1 }}>
            <Send size={13} /> {busy ? 'Sending…' : sent.length ? 'Send again' : 'Send to Finance'}
          </button>
        )}
      </div>
      {err && <div role="alert" style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{err}</div>}
      {sent.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>
              <th style={{ padding: '6px 8px' }}>Contractor</th><th style={{ padding: '6px 8px' }}>Workers</th>
              <th style={{ padding: '6px 8px' }}>Man-days</th><th style={{ padding: '6px 8px' }}>Hours</th>
            </tr>
          </thead>
          <tbody>
            {sent.map((s) => (
              <tr key={s.id} style={{ borderTop: '1px solid #f5f3ff' }}>
                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{s.contractor_company}</td>
                <td style={{ padding: '6px 8px' }}>{s.workers}</td>
                <td style={{ padding: '6px 8px', color: P, fontWeight: 600 }}>{Number(s.present_days)}</td>
                <td style={{ padding: '6px 8px' }}>{Number(s.hours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
