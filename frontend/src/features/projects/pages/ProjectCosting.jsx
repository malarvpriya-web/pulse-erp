import { useEffect, useState } from 'react';
import api from '@/services/api/client';

const money = (n) =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pctBar = (pct) => {
  const capped = Math.min(pct, 100);
  const color = pct > 90 ? '#dc2626' : pct > 70 ? '#d97706' : '#059669';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: '#f0f0f4', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${capped}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 36 }}>{pct}%</span>
    </div>
  );
};

const thS = { padding: '8px 12px', textAlign: 'left', fontSize: 12, color: '#6b7280', fontWeight: 600, borderBottom: '1px solid #e5e7eb', background: '#fafafa', whiteSpace: 'nowrap' };
const tdS = { padding: '8px 12px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };

export default function ProjectCosting() {
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [cost, setCost] = useState(null);
  const [loading, setLoading] = useState(false);
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [inProgressData, setInProgressData] = useState([]);
  const [inProgressLoading, setInProgressLoading] = useState(false);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const res = await api.get('/projects/projects', { params: { status: 'completed' } });
      const rows = Array.isArray(res.data) ? res.data : (res.data?.rows ?? []);
      setProjects(rows);
      if (!selectedId && rows.length > 0) setSelectedId(String(rows[0].id));
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  };

  const loadInProgress = async () => {
    setInProgressLoading(true);
    try {
      const res = await api.get('/projects/costing/in-progress');
      setInProgressData(Array.isArray(res.data) ? res.data : []);
    } catch {
      setInProgressData([]);
    } finally {
      setInProgressLoading(false);
    }
  };

  const loadCost = async (projectId) => {
    if (!projectId) return;
    try {
      const res = await api.get(`/projects/projects/${projectId}/costs`);
      setCost(res.data ?? null);
    } catch {
      setCost(null);
    }
  };

  const recalculate = async () => {
    if (!selectedId) return;
    setRecalcLoading(true);
    try {
      const res = await api.post(`/projects/projects/${selectedId}/costs/recalculate`);
      setCost(res.data ?? null);
    } catch {
      // no-op
    } finally {
      setRecalcLoading(false);
    }
  };

  useEffect(() => { loadProjects(); loadInProgress(); }, []);
  useEffect(() => { loadCost(selectedId); }, [selectedId]);

  const selectedProject = (projects ?? []).find((p) => String(p.id) === String(selectedId));

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <h2 style={{ margin: '0 0 6px 0', fontSize: 22, fontWeight: 700, color: '#111827' }}>Project Costing</h2>
      <p style={{ margin: '0 0 20px 0', color: '#6b7280', fontSize: 14 }}>
        Final project cost is rolled up from material, labour, travel, and manufacturing when completed.
      </p>

      {/* ── Completed projects ─────────────────────────────────────────── */}
      {loading && <div style={{ color: '#6b7280', fontSize: 13 }}>Loading completed projects…</div>}

      {!loading && (projects ?? []).length === 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '40px 24px', textAlign: 'center', gap: 8,
          background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', marginBottom: 24,
        }}>
          <div style={{ fontSize: 32, marginBottom: 4 }}>📂</div>
          <p style={{ fontSize: 15, fontWeight: 500, color: '#111827', margin: 0 }}>No completed projects found</p>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
            Final costs are rolled up when a project status is set to "completed".
          </p>
        </div>
      )}

      {!loading && (projects ?? []).length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
            <label style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>Completed Project</label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}
            >
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p?.project_code} - {p?.project_name}
                </option>
              ))}
            </select>
            <div style={{ marginTop: 12, color: '#6b7280', fontSize: 13 }}>
              Budget: <strong>{money(selectedProject?.budget_amount ?? 0)}</strong>
            </div>
            <button
              onClick={recalculate}
              disabled={recalcLoading}
              style={{ marginTop: 14, padding: '8px 12px', borderRadius: 8, border: '1px solid #6B3FDB', background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontSize: 13 }}
            >
              {recalcLoading ? 'Recalculating…' : 'Recalculate Final Cost'}
            </button>
          </div>

          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
            <h4 style={{ marginTop: 0, fontSize: 15 }}>Cost Breakdown</h4>
            {!cost && <div style={{ color: '#6b7280', fontSize: 13 }}>No cost data available for this project.</div>}
            {cost && (
              <div style={{ display: 'grid', gap: 10 }}>
                {[
                  ['Material Cost', cost?.material_cost],
                  ['Labour Cost', cost?.labour_cost],
                  ['Travel Cost', cost?.travel_cost],
                  ['Manufacturing Cost', cost?.manufacturing_cost],
                  ['Other Expense', cost?.expense_cost],
                ].map(([label, val]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: '#6b7280' }}>{label}</span>
                    <strong>{money(val ?? 0)}</strong>
                  </div>
                ))}
                <hr style={{ border: 0, borderTop: '1px solid #e5e7eb', margin: '4px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 700 }}>
                  <span>Total Project Cost</span>
                  <span style={{ color: '#111827' }}>{money(cost?.total_cost ?? 0)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── In-progress cost preview ────────────────────────────────────── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #f0f0f4' }}>
          <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#111827' }}>Cost-to-Date — Active Projects</h4>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
            Live cost incurred across all in-progress and planning projects
          </p>
        </div>

        {inProgressLoading && (
          <div style={{ padding: 24, color: '#6b7280', fontSize: 13 }}>Loading active project costs…</div>
        )}

        {!inProgressLoading && (inProgressData ?? []).length === 0 && (
          <div style={{ padding: '32px 24px', textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
            No active or planning projects found.
          </div>
        )}

        {!inProgressLoading && (inProgressData ?? []).length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
              <thead>
                <tr>
                  {['Project', 'Budget', 'Material', 'Labour', 'Travel', 'Mfg.', 'Total Incurred', '% of Budget'].map(h => (
                    <th key={h} style={thS}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(inProgressData ?? []).map((p, i) => {
                  const incurred =
                    (p?.material_cost ?? 0) +
                    (p?.labour_cost ?? 0) +
                    (p?.travel_cost ?? 0) +
                    (p?.manufacturing_cost ?? 0) +
                    (p?.expense_cost ?? 0);
                  const budget = p?.budget_amount ?? 0;
                  const pct = budget > 0 ? Math.round((incurred / budget) * 100) : 0;
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={tdS}>
                        <div style={{ fontWeight: 600 }}>{p?.project_name ?? '—'}</div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>{p?.project_code ?? ''}</div>
                      </td>
                      <td style={tdS}>{money(budget)}</td>
                      <td style={tdS}>{money(p?.material_cost ?? 0)}</td>
                      <td style={tdS}>{money(p?.labour_cost ?? 0)}</td>
                      <td style={tdS}>{money(p?.travel_cost ?? 0)}</td>
                      <td style={tdS}>{money(p?.manufacturing_cost ?? 0)}</td>
                      <td style={{ ...tdS, fontWeight: 700 }}>{money(incurred)}</td>
                      <td style={{ ...tdS, minWidth: 120 }}>{pctBar(pct)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
