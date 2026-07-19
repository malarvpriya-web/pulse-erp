import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { fmt as fmtAmt } from './travelUtils';

const STATUS_STYLE = {
  Approved:  { background: '#dcfce7', color: '#166534' },
  Pending:   { background: '#fef9c3', color: '#854d0e' },
  Rejected:  { background: '#fee2e2', color: '#991b1b' },
  Cancelled: { background: '#f3f4f6', color: '#374151' },
};

export default function TravelEntry() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    setLoading(true);
    api.get('/travel/my-entries')
      .then(r => setEntries(Array.isArray(r.data) ? r.data : []))
      .catch(() => setError('Could not load travel entries. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>My Travel Entries</h1>

      {loading && (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      )}

      {!loading && error && (
        <div style={{ background: '#fee2e2', borderRadius: 12, padding: 24, color: '#991b1b', textAlign: 'center' }}>
          {error}
        </div>
      )}

      {!loading && !error && entries.length === 0 && (
        <div style={{
          background: '#fff', borderRadius: 12, padding: 40,
          textAlign: 'center', color: '#9ca3af',
          boxShadow: '0 1px 4px rgba(0,0,0,.08)',
        }}>
          No travel entries yet. Submit a new travel request to get started.
        </div>
      )}

      {!loading && !error && entries.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['#', 'Purpose', 'Start', 'End', 'Days', 'Status', 'Amount'].map(h => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: 'left', fontWeight: 600,
                      color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const statusStyle = STATUS_STYLE[e?.status] ?? STATUS_STYLE.Cancelled;
                  return (
                    <tr key={e?.id ?? i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '9px 14px', color: '#6b7280' }}>{i + 1}</td>
                      <td style={{ padding: '9px 14px' }}>{e?.purpose ?? '—'}</td>
                      <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>{fmtDate(e?.start)}</td>
                      <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>{fmtDate(e?.end)}</td>
                      <td style={{ padding: '9px 14px', textAlign: 'center' }}>{e?.days ?? '—'}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{
                          ...statusStyle,
                          padding: '2px 10px', borderRadius: 20,
                          fontSize: 11, fontWeight: 600,
                        }}>
                          {e?.status ?? 'Pending'}
                        </span>
                      </td>
                      <td style={{ padding: '9px 14px', fontWeight: 500 }}>{fmtAmt(e?.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
