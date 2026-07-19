import { useState, useEffect } from 'react';
import api from '@/services/api/client';

export default function GenericListPage({ title, endpoint }) {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get(endpoint)
      .then(r => setData(Array.isArray(r.data) ? r.data : []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [endpoint]);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>{title}</h1>
      {loading && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading...</div>}
      {!loading && data.length === 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 40, textAlign: 'center', color: '#9ca3af', boxShadow: '0 1px 4px rgba(0,0,0,.08)' }}>
          No records found. Add your first entry to get started.
        </div>
      )}
      {!loading && data.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {Object.keys(data[0]).map(k => (
                    <th key={k} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    {Object.values(row).map((v, j) => (
                      <td key={j} style={{ padding: '9px 14px' }}>{String(v ?? '-')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
