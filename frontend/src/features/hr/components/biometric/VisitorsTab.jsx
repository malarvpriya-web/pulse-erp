// Visitor Management tab — check in, filter, check out, print a badge.
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { S, fmtStamp, errText, esc, phoneProblem, printDocument } from './biometricShared';
import { Field, Pager, EmptyRow, EmployeeSelect } from './biometricUi';

const EMPTY_FORM = { name: '', company: '', phone: '', email: '', host_employee_id: '', purpose: '', id_type: 'Aadhaar', id_number: '' };
const EMPTY_FILTERS = { q: '', host_employee_id: '', status: '', from: '', to: '' };

function printBadge(v) {
  const row = (k, val) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`;
  return printDocument(`Visitor badge — ${v.name}`, `
    <div class="card">
      <h1>VISITOR</h1>
      <div class="sub">Badge #${esc(v.id)} · checked in ${esc(fmtStamp(v.check_in_time))}</div>
      <table>
        ${row('Name', v.name)}
        ${row('Company', v.company || '—')}
        ${row('Host', v.host_name || '—')}
        ${row('Purpose', v.purpose || '—')}
      </table>
      <span class="stamp ok">VALID FOR THIS VISIT ONLY</span>
      <div class="sign"><span>Return this badge at check-out</span><span>Security</span></div>
    </div>`);
}

export default function VisitorsTab({ employees, flash, canWrite, onDataChanged }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0, page_size: 25, inside_total: 0 });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, page_size: 25 };
      for (const [k, v] of Object.entries(filters)) if (v !== '') params[k] = v;
      const res = await api.get('/visitors', { params });
      setData(res.data?.rows ? res.data : { rows: [], total: 0, page_size: 25, inside_total: 0 });
      setLoadError('');
    } catch (err) {
      setData({ rows: [], total: 0, page_size: 25, inside_total: 0 });
      setLoadError(errText(err, 'Could not load visitors'));
    } finally { setLoading(false); }
  }, [filters, page]);
  useEffect(() => { load(); }, [load]);

  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setPage(1); };
  const filtered = Object.values(filters).some((v) => v !== '');
  const closeForm = () => { setShowForm(false); setForm(EMPTY_FORM); setFormErrors([]); };

  const submit = async (e) => {
    e.preventDefault();
    const problems = [];
    if (!form.name.trim()) problems.push('Visitor name is required.');
    const phone = phoneProblem(form.phone);
    if (phone) problems.push(phone);
    setFormErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      const res = await api.post('/visitors', form);
      flash(`${res.data?.name || 'Visitor'} checked in`);
      closeForm(); load(); onDataChanged();
    } catch (err) {
      setFormErrors(err.response?.data?.errors || [errText(err, 'Check-in failed')]);
    } finally { setSaving(false); }
  };

  const checkOut = async (v) => {
    setBusy((b) => ({ ...b, [v.id]: true }));
    try {
      await api.put(`/visitors/${v.id}/checkout`);
      flash(`${v.name} checked out`);
    } catch (err) {
      flash(errText(err, 'Check-out failed'), 'error');
    } finally {
      setBusy((b) => ({ ...b, [v.id]: false }));
      load(); onDataChanged();
    }
  };

  const badge = async (v) => {
    if (!printBadge(v)) { flash('The print window was blocked by the browser. Allow pop-ups for Pulse and try again.', 'error'); return; }
    if (v.badge_printed || !canWrite) return;
    try { await api.put(`/visitors/${v.id}/badge`); load(); }
    catch (err) { flash(errText(err, 'Badge printed, but it could not be recorded'), 'error'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, color: '#4c1d95' }}>Visitor Management</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }} data-testid="inside-count">
            {data.inside_total} visitor{data.inside_total === 1 ? '' : 's'} currently inside
          </p>
        </div>
        {canWrite && (
          <button type="button" onClick={() => (showForm ? closeForm() : setShowForm(true))} style={S.primary}>
            {showForm ? '✕ Cancel' : '+ New Visitor'}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={submit} noValidate data-testid="visitor-form" style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
            {[['name', 'Visitor Name *', 'text', 200], ['company', 'Company', 'text', 200], ['phone', 'Contact number', 'tel', 20], ['email', 'Email', 'email', 200]].map(([key, label, type, max]) => (
              <div key={key}>
                <label style={S.label} htmlFor={`vf-${key}`}>{label}</label>
                <input id={`vf-${key}`} type={type} maxLength={max} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} style={S.input} />
              </div>
            ))}
            <div>
              <label style={S.label} htmlFor="vf-host">Host employee</label>
              <EmployeeSelect id="vf-host" employees={employees} value={form.host_employee_id} onChange={(v) => setForm((f) => ({ ...f, host_employee_id: v }))} placeholder="No host" />
            </div>
            <div>
              <label style={S.label} htmlFor="vf-purpose">Purpose</label>
              <input id="vf-purpose" value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} style={S.input} />
            </div>
            <div>
              <label style={S.label} htmlFor="vf-idtype">ID Type</label>
              <select id="vf-idtype" value={form.id_type} onChange={(e) => setForm((f) => ({ ...f, id_type: e.target.value }))} style={S.input}>
                {['Aadhaar', 'PAN', 'Passport', 'DL', 'Voter ID', 'Other'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label} htmlFor="vf-idno">ID Number</label>
              <input id="vf-idno" maxLength={100} value={form.id_number} onChange={(e) => setForm((f) => ({ ...f, id_number: e.target.value }))} style={S.input} />
            </div>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#6b7280' }}>Check-in time is recorded when you save. Print the badge from the visitor’s row.</p>
          {formErrors.length > 0 && (
            <ul role="alert" style={{ margin: '10px 0 0', paddingLeft: 18, color: '#b91c1c', fontSize: 13 }}>
              {formErrors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button type="submit" disabled={saving} style={{ ...S.primary, opacity: saving ? 0.6 : 1 }}>{saving ? 'Checking in…' : 'Check In'}</button>
            <button type="button" onClick={closeForm} style={S.secondary}>Cancel</button>
          </div>
        </form>
      )}

      <div style={S.filterBar} data-testid="visitor-filters">
        <Field label="Search" width={200}><input type="search" placeholder="Name, company, phone, host" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} style={S.input} /></Field>
        <Field label="Host" width={180}><EmployeeSelect employees={employees} value={filters.host_employee_id} onChange={(v) => setFilter('host_employee_id', v)} placeholder="All hosts" /></Field>
        <Field label="Status" width={150}>
          <select aria-label="Visitor status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} style={S.input}>
            <option value="">All</option>
            <option value="inside">Inside</option>
            <option value="checked_out">Checked out</option>
          </select>
        </Field>
        <Field label="Checked in from" width={140}><input type="date" aria-label="Checked in from" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} style={S.input} /></Field>
        <Field label="to" width={140}><input type="date" aria-label="Checked in to" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} style={S.input} /></Field>
        <button type="button" onClick={clearFilters} disabled={!filtered} style={{ ...S.secondary, padding: '7px 12px', opacity: filtered ? 1 : 0.5 }}>Clear filters</button>
      </div>
      {loadError && <div role="alert" style={{ color: '#b91c1c', fontSize: 13, marginBottom: 8 }}>{loadError}</div>}

      <div style={{ overflowX: 'auto', opacity: loading ? 0.6 : 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="visitor-table">
          <thead><tr style={{ background: '#f5f3ff' }}>
            {['Visitor', 'Company', 'Phone', 'Host', 'Purpose', 'Check In', 'Check Out', 'Action'].map((h) => <th key={h} style={S.th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {data.rows.length === 0 && !loading && <EmptyRow cols={8} filtered={filtered} onClear={clearFilters} what="visitors" />}
            {data.rows.map((v) => {
              const inside = !v.check_out_time;
              return (
                <tr key={v.id} style={{ borderBottom: '1px solid #f0ebff', background: inside ? '#fafffe' : '#fff' }}>
                  <td style={{ ...S.td, fontWeight: 600 }}>
                    {v.name}
                    {v.badge_printed && <span style={{ marginLeft: 6, fontSize: 10, background: '#ede9fe', color: '#6B3FDB', padding: '1px 5px', borderRadius: 8, fontWeight: 600 }} title="A badge was printed for this visit">Badge ✓</span>}
                  </td>
                  <td style={{ ...S.td, color: '#6b7280' }}>{v.company || '—'}</td>
                  <td style={{ ...S.td, color: '#6b7280', whiteSpace: 'nowrap' }}>{v.phone || '—'}</td>
                  <td style={S.td}>{v.host_name || '—'}</td>
                  <td style={{ ...S.td, color: '#6b7280', fontSize: 12 }}>{v.purpose || '—'}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12 }}>{fmtStamp(v.check_in_time)}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: 12, color: inside ? '#16a34a' : '#6b7280', fontWeight: inside ? 600 : 400 }}>
                    {inside ? 'Inside' : fmtStamp(v.check_out_time)}
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    {canWrite && inside && (
                      <button type="button" disabled={busy[v.id]} onClick={() => checkOut(v)} style={S.small('#dc2626')}>Check Out</button>
                    )}
                    {inside && (
                      <button type="button" onClick={() => badge(v)} style={S.small('#e9e4ff', '#6B3FDB')}>🖨️ Badge</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager page={data.page || page} pageSize={data.page_size || 25} total={data.total} onPage={setPage} />
    </div>
  );
}
