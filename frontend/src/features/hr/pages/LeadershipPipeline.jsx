// frontend/src/features/hr/pages/LeadershipPipeline.jsx
import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

/* ─── style tokens ──────────────────────────────────────────── */
const INP = { width: '100%', boxSizing: 'border-box', padding: '7px 10px',
              border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };
const LBL = { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 };
const BTN = (v = 'primary', sm = false) => ({
  border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600,
  fontSize: sm ? 12 : 13, padding: sm ? '4px 10px' : '8px 18px',
  background: v === 'primary' ? '#6B3FDB' : v === 'danger' ? '#ef4444' : v === 'ghost' ? 'none' : '#e9e4ff',
  color: v === 'primary' ? '#fff' : v === 'danger' ? '#fff' : v === 'ghost' ? '#6b7280' : '#6B3FDB',
  ...(v === 'outline' ? { border: '1px solid #6B3FDB', background: 'none', color: '#6B3FDB' } : {}),
});

const READY_COLORS = { 'ready-now': '#16a34a', '1-2-years': '#d97706', '3-5-years': '#6b7280', 'not_ready': '#ef4444' };
const READY_LABELS = { 'ready-now': 'Ready Now', '1-2-years': '1-2 Yrs', '3-5-years': '3-5 Yrs', 'not_ready': 'Not Ready' };

function Spinner() {
  return (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <style>{`@keyframes _spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'inline-block', width: 36, height: 36, border: '3px solid #e9e4ff',
                    borderTopColor: '#6B3FDB', borderRadius: '50%', animation: '_spin .75s linear infinite' }} />
    </div>
  );
}

function Flash({ msg }) {
  if (!msg.text) return null;
  return (
    <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14,
                  background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
                  color:      msg.type === 'error' ? '#dc2626' : '#16a34a',
                  border:     `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
      {msg.text}
    </div>
  );
}

const ENTRY_DEFAULT = {
  employee_id: '', current_level_id: '', target_level_id: '',
  current_since: '', target_date: '', readiness: '1-2-years', notes: '',
};

export default function LeadershipPipeline() {
  const [levels,  setLevels]   = useState([]);
  const [entries, setEntries]  = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]  = useState(true);
  const [saving,  setSaving]   = useState(false);
  const [msg, setMsg]          = useState({ text: '', type: '' });
  const [selLevel, setSelLevel] = useState(null);

  const [showForm, setShowForm]     = useState(false);
  const [editId,   setEditId]       = useState(null);
  const [form,     setForm]         = useState(ENTRY_DEFAULT);
  const [pendingRemoveEntry, setPendingRemoveEntry] = useState(null);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 3500);
  };

  const load = useCallback(async () => {
    const [lvRes, enRes] = await Promise.allSettled([
      api.get('/succession/pipeline/levels'),
      api.get('/succession/pipeline/entries'),
    ]);
    if (lvRes.status === 'fulfilled') setLevels(lvRes.value.data || []);
    if (enRes.status === 'fulfilled') setEntries(enRes.value.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/employees?status=active').then(r => setEmployees(r.data || [])).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        employee_id:      parseInt(form.employee_id),
        current_level_id: parseInt(form.current_level_id),
        target_level_id:  form.target_level_id ? parseInt(form.target_level_id) : null,
        current_since:    form.current_since || null,
        target_date:      form.target_date || null,
      };
      if (editId) {
        await api.patch(`/succession/pipeline/entries/${editId}`, payload);
        flash('Entry updated');
      } else {
        await api.post('/succession/pipeline/entries', payload);
        flash('Employee added to pipeline');
      }
      setShowForm(false);
      setEditId(null);
      setForm(ENTRY_DEFAULT);
      load();
    } catch (err) {
      flash(err.response?.data?.message || 'Failed to save', 'error');
    } finally { setSaving(false); }
  };

  const removeEntry = async () => {
    if (!pendingRemoveEntry) return;
    const { id, name } = pendingRemoveEntry;
    setPendingRemoveEntry(null);
    try {
      await api.delete(`/succession/pipeline/entries/${id}`);
      flash('Removed');
      setSelLevel(null);
      load();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
  };

  const startEdit = (entry) => {
    setForm({
      employee_id:      entry.employee_id,
      current_level_id: entry.current_level_id,
      target_level_id:  entry.target_level_id || '',
      current_since:    entry.current_since?.split('T')[0] || '',
      target_date:      entry.target_date?.split('T')[0] || '',
      readiness:        entry.readiness || '1-2-years',
      notes:            entry.notes || '',
    });
    setEditId(entry.id);
    setShowForm(true);
  };

  const assignedIds = new Set(entries.map(e => e.employee_id));
  const levelById   = Object.fromEntries(levels.map(l => [l.id, l]));

  const entriesByLevel = {};
  for (const l of levels) entriesByLevel[l.id] = [];
  for (const e of entries) {
    if (entriesByLevel[e.current_level_id]) {
      entriesByLevel[e.current_level_id].push(e);
    }
  }

  const levelColors = ['#6b7280','#0891b2','#2563eb','#6B3FDB','#d97706','#dc2626'];

  if (loading) return <div style={{ padding: 24 }}><Spinner /></div>;

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingRemoveEntry}
        title="Remove from Pipeline"
        message={pendingRemoveEntry ? `Remove ${pendingRemoveEntry.name} from the leadership pipeline?` : ''}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={removeEntry}
        onCancel={() => setPendingRemoveEntry(null)}
      />
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Leadership Pipeline</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          Track employees' progression through leadership levels
        </p>
      </div>

      <Flash msg={msg} />

      {/* Add entry button */}
      <div style={{ marginBottom: 20 }}>
        <button style={BTN(showForm ? 'secondary' : 'primary')}
          onClick={() => { showForm ? (setShowForm(false), setEditId(null), setForm(ENTRY_DEFAULT)) : setShowForm(true); }}>
          {showForm ? 'X Cancel' : '+ Add to Pipeline'}
        </button>
      </div>

      {/* Entry form */}
      {showForm && (
        <form onSubmit={submit}
          style={{ background: '#fff', borderRadius: 10, padding: 20, marginBottom: 24,
                   border: '1px solid #e9e4ff', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <h4 style={{ margin: '0 0 16px', color: '#4c1d95' }}>
            {editId ? 'Edit Pipeline Entry' : 'Add Employee to Pipeline'}
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
            <div>
              <label style={LBL}>Employee *</label>
              <select required value={form.employee_id}
                onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
                style={INP}>
                <option value="">— Select —</option>
                {employees.filter(emp => editId || !assignedIds.has(emp.id)).map(emp => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}{emp.designation ? ` — ${emp.designation}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={LBL}>Current Level *</label>
              <select required value={form.current_level_id}
                onChange={e => setForm(f => ({ ...f, current_level_id: e.target.value }))}
                style={INP}>
                <option value="">— Select level —</option>
                {levels.map(l => (
                  <option key={l.id} value={l.id}>{l.level_order}. {l.level_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={LBL}>Target Level</label>
              <select value={form.target_level_id}
                onChange={e => setForm(f => ({ ...f, target_level_id: e.target.value }))}
                style={INP}>
                <option value="">— Same / Not set —</option>
                {levels.map(l => (
                  <option key={l.id} value={l.id}>{l.level_order}. {l.level_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={LBL}>Readiness</label>
              <select value={form.readiness}
                onChange={e => setForm(f => ({ ...f, readiness: e.target.value }))}
                style={INP}>
                {Object.entries(READY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={LBL}>Current Since</label>
              <input type="date" value={form.current_since}
                onChange={e => setForm(f => ({ ...f, current_since: e.target.value }))}
                style={INP} />
            </div>
            <div>
              <label style={LBL}>Target Date (next level)</label>
              <input type="date" value={form.target_date}
                onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))}
                style={INP} />
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={LBL}>Notes</label>
              <input value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Development notes..."
                style={INP} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="submit" disabled={saving} style={BTN('primary')}>
              {saving ? 'Saving...' : editId ? 'Update' : 'Add to Pipeline'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditId(null); setForm(ENTRY_DEFAULT); }}
              style={BTN('ghost')}>Cancel</button>
          </div>
        </form>
      )}

      {/* Pipeline visualization */}
      {levels.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>-</div>
          <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 16 }}>No pipeline levels configured</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Pipeline levels are seeded automatically when the migration runs.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Totals bar */}
          <div style={{ background: '#fff', borderRadius: 10, padding: '12px 20px',
                        border: '1px solid #e9e4ff', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: '#4c1d95', fontWeight: 600 }}>
              Total in pipeline: {entries.length}
            </div>
            {levels.map((l, i) => {
              const cnt = (entriesByLevel[l.id] || []).length;
              return cnt > 0 ? (
                <div key={l.id} style={{ fontSize: 12, color: '#6b7280' }}>
                  <span style={{ fontWeight: 700, color: levelColors[i % levelColors.length] }}>{cnt}</span>
                  {' '}{l.level_name}
                </div>
              ) : null;
            })}
          </div>

          {/* Level cards - reverse order so highest level appears first */}
          {[...levels].reverse().map((level, i) => {
            const levelEntries = entriesByLevel[level.id] || [];
            const colorIdx     = (levels.length - 1 - i) % levelColors.length;
            const color        = levelColors[colorIdx];
            const isSelected   = selLevel === level.id;

            return (
              <div key={level.id}
                style={{ background: '#fff', borderRadius: 12, border: `2px solid ${isSelected ? color : '#e9e4ff'}`,
                         overflow: 'hidden', cursor: 'pointer' }}
                onClick={() => setSelLevel(isSelected ? null : level.id)}>

                {/* Level header */}
                <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between',
                              alignItems: 'center', background: isSelected ? color + '10' : '#fafafa' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: color,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  color: '#fff', fontWeight: 900, fontSize: 16 }}>
                      {level.level_order}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>
                        {level.level_name}
                      </div>
                      {level.description && (
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>
                          {level.description}
                          {level.required_experience_yrs > 0
                            ? ` · ${level.required_experience_yrs}+ years required` : ''}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontWeight: 900, fontSize: 20, color: levelEntries.length > 0 ? color : '#d1d5db' }}>
                      {levelEntries.length}
                    </span>
                    <span style={{ fontSize: 16, color: '#9ca3af' }}>{isSelected ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Employees in this level */}
                {isSelected && (
                  <div style={{ padding: '16px 20px', borderTop: '1px solid #e9e4ff' }}>
                    {levelEntries.length === 0 ? (
                      <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
                        No employees at this level yet.
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 10 }}>
                        {levelEntries.map(entry => {
                          const readyColor = READY_COLORS[entry.readiness] || '#6b7280';
                          const targetLevel = levelById[entry.target_level_id];
                          return (
                            <div key={entry.id}
                              style={{ background: '#f5f3ff', borderRadius: 10, padding: 14,
                                       border: '1px solid #e9e4ff' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                <div>
                                  <div style={{ fontWeight: 700, fontSize: 13, color: '#1f2937' }}>
                                    {entry.employee_name}
                                  </div>
                                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                                    {entry.designation}
                                    {entry.department ? ` · ${entry.department}` : ''}
                                  </div>
                                </div>
                                <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11,
                                               fontWeight: 600, background: readyColor + '20', color: readyColor,
                                               height: 'fit-content' }}>
                                  {READY_LABELS[entry.readiness] || entry.readiness}
                                </span>
                              </div>

                              {targetLevel && (
                                <div style={{ fontSize: 11, color: '#6B3FDB', marginBottom: 6 }}>
                                  Target: {targetLevel.level_name}
                                  {entry.target_date
                                    ? ` by ${new Date(entry.target_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`
                                    : ''}
                                </div>
                              )}

                              {(entry.performance_score || entry.potential_score) && (
                                <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                                  {entry.performance_score && (
                                    <span>Perf: <strong style={{ color: '#16a34a' }}>{entry.performance_score}/5</strong></span>
                                  )}
                                  {entry.potential_score && (
                                    <span>Pot: <strong style={{ color: '#6B3FDB' }}>{entry.potential_score}/5</strong></span>
                                  )}
                                </div>
                              )}

                              {entry.notes && (
                                <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic',
                                             marginBottom: 8, borderLeft: '2px solid #e9e4ff', paddingLeft: 8 }}>
                                  {entry.notes}
                                </div>
                              )}

                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={(e) => { e.stopPropagation(); startEdit(entry); }}
                                  style={BTN('outline', true)}>Edit</button>
                                <button onClick={(e) => { e.stopPropagation(); setPendingRemoveEntry({ id: entry.id, name: entry.employee_name }); }}
                                  style={{ ...BTN('ghost', true), color: '#ef4444', border: 'none', fontSize: 12 }}>
                                  Remove
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {!showForm && (
                      <button onClick={(e) => {
                        e.stopPropagation();
                        setForm({ ...ENTRY_DEFAULT, current_level_id: level.id });
                        setShowForm(true);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }} style={{ ...BTN('outline', true), marginTop: 12 }}>
                        + Add employee to {level.level_name}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
