/**
 * R&D improvement inputs (§277) — shared by the bid close form, the closed-deal
 * drawer (Opportunities board) and the commissioning workflow page.
 *
 *   <RdPointsEditor value onChange />   controlled list of points, for a form that
 *                                        saves them together with something else
 *   <RdInputsPanel opportunityId | commissioningId canAdd />
 *                                        what was already raised on a record, with
 *                                        R&D's answer, and a form to add more
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, FlaskConical } from 'lucide-react';
import api from '@/services/api/client';

export const RD_CATEGORIES = {
  product_feature: 'Product feature',
  performance:     'Performance',
  quality:         'Quality / reliability',
  cost:            'Cost / price',
  documentation:   'Documentation',
  installation:    'Installation / site',
  software:        'Software / firmware',
  other:           'Other',
};
export const RD_PRIORITIES = { high: 'High', medium: 'Medium', low: 'Low' };
export const RD_STATUS = {
  new:          { label: 'New',          color: '#6b7280' },
  under_review: { label: 'Under review', color: '#2563eb' },
  accepted:     { label: 'Accepted',     color: '#6B3FDB' },
  rejected:     { label: 'Rejected',     color: '#dc2626' },
  implemented:  { label: 'Implemented',  color: '#059669' },
};
export const RD_SOURCE = {
  sales_won:     'Sales — won',
  sales_lost:    'Sales — lost',
  commissioning: 'Commissioning',
  service:       'Service',
};

export const emptyPoint = () => ({ requirement: '', category: 'product_feature', priority: 'medium' });
/** Points with text — what a form should send. */
export const filledPoints = (list) => (list || []).filter((p) => String(p.requirement || '').trim());

const INP = { width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', background: '#fff' };
const SMALL_BTN = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };

export function RdStatusChip({ status }) {
  const s = RD_STATUS[status] || RD_STATUS.new;
  return (
    <span style={{ background: `${s.color}1a`, color: s.color, padding: '2px 8px', borderRadius: 9, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

export function RdPointsEditor({ value, onChange, disabled = false }) {
  const list = value?.length ? value : [emptyPoint()];
  const update = (i, k, v) => onChange(list.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const remove = (i) => onChange(list.length === 1 ? [emptyPoint()] : list.filter((_, j) => j !== i));
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {list.map((p, i) => (
        <div key={i} style={{ border: '1px solid #f0f0f4', borderRadius: 10, padding: 10, background: '#fafafb', display: 'grid', gap: 6 }}>
          <textarea
            style={{ ...INP, minHeight: 52, resize: 'vertical' }}
            value={p.requirement}
            disabled={disabled}
            maxLength={2000}
            onChange={(e) => update(i, 'requirement', e.target.value)}
            placeholder="What should R&D improve or add? e.g. Customer needs Modbus TCP, not only RS-485"
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select style={{ ...INP, flex: 2 }} value={p.category} disabled={disabled} onChange={(e) => update(i, 'category', e.target.value)}>
              {Object.entries(RD_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select style={{ ...INP, flex: 1 }} value={p.priority} disabled={disabled} onChange={(e) => update(i, 'priority', e.target.value)}>
              {Object.entries(RD_PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <button type="button" style={{ ...SMALL_BTN, padding: 7 }} disabled={disabled} onClick={() => remove(i)} title="Remove this point" aria-label="Remove this point">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      <button type="button" style={{ ...SMALL_BTN, justifySelf: 'start' }} disabled={disabled || list.length >= 20}
        onClick={() => onChange([...list, emptyPoint()])}>
        <Plus size={13} /> Add another point
      </button>
    </div>
  );
}

export function RdInputsPanel({ opportunityId, commissioningId, canAdd = false, title = 'Inputs for R&D', hint }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState([emptyPoint()]);
  const [saving, setSaving] = useState(false);

  const params = opportunityId ? { opportunity_id: opportunityId } : { commissioning_id: commissioningId };
  const key = opportunityId ? `o${opportunityId}` : `c${commissioningId}`;

  const load = useCallback(() => {
    setLoading(true);
    api.get('/rd-inputs/for', { params })
      .then(({ data }) => { setRows(data?.data || []); setError(null); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load R&D inputs'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const points = filledPoints(draft);
    if (!points.length) { setError('Write at least one point'); return; }
    setSaving(true); setError(null);
    try {
      await api.post('/rd-inputs', { ...params, points });
      setDraft([emptyPoint()]); setAdding(false); load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save');
    } finally { setSaving(false); }
  };

  const withdraw = async (id) => {
    try { await api.delete(`/rd-inputs/${id}`); load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not withdraw'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <FlaskConical size={15} color="#6B3FDB" />
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{title}</span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{rows.length ? `(${rows.length})` : ''}</span>
      </div>
      {hint && <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6b7280' }}>{hint}</p>}
      {error && <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '6px 10px', borderRadius: 8, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {loading ? (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div>
      ) : rows.length === 0 && !adding ? (
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>No R&D points recorded.</div>
      ) : (
        <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ border: '1px solid #f0f0f4', borderRadius: 10, padding: '8px 10px', background: '#fff' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, fontSize: 13, color: '#111827', whiteSpace: 'pre-wrap' }}>{r.requirement}</div>
                <RdStatusChip status={r.status} />
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span>{RD_CATEGORIES[r.category] || r.category}</span>
                <span>· {RD_PRIORITIES[r.priority] || r.priority} priority</span>
                <span>· {RD_SOURCE[r.source] || r.source}</span>
                {r.raised_by_name && <span>· {r.raised_by_name}</span>}
                {r.status === 'new' && canAdd && (
                  <button type="button" onClick={() => withdraw(r.id)}
                    style={{ marginLeft: 'auto', border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 11, padding: 0 }}>
                    Withdraw
                  </button>
                )}
              </div>
              {r.rd_response && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#374151', background: '#f5f3ff', borderRadius: 8, padding: '6px 8px' }}>
                  <strong>R&D:</strong> {r.rd_response}
                  {r.reviewed_by_name && <span style={{ color: '#9ca3af' }}> — {r.reviewed_by_name}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {canAdd && (adding ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <RdPointsEditor value={draft} onChange={setDraft} disabled={saving} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="pulse-btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save points'}</button>
            <button type="button" className="pulse-btn-secondary" disabled={saving} onClick={() => { setAdding(false); setDraft([emptyPoint()]); setError(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" style={SMALL_BTN} onClick={() => setAdding(true)}><Plus size={13} /> Add R&D points</button>
      ))}
    </div>
  );
}
