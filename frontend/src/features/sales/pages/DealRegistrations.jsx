/**
 * DealRegistrations — partner channel conflict management.
 *
 * The screen exists to make a refusal legible. The two things it must show
 * clearly are (a) which customers are currently protected and by whom, and
 * (b) why a registration cannot be approved — the server's own refusal text is
 * surfaced verbatim rather than replaced with "action failed".
 *
 * The check-before-you-register box is the part partners actually use: finding
 * out at submission that a customer is taken beats finding out three days later.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  Handshake, Search, Plus, X, Check, Ban, Clock, ShieldCheck, AlertTriangle, Link2,
} from 'lucide-react';
import { PageHero, PageShell } from '@/components/pulse-ui';

const STATES = {
  submitted: { label: 'Pending',   fg: '#b45309', bg: '#fef3c7' },
  approved:  { label: 'Protected', fg: '#047857', bg: '#d1fae5' },
  rejected:  { label: 'Rejected',  fg: '#b91c1c', bg: '#fee2e2' },
  expired:   { label: 'Expired',   fg: '#6b7280', bg: '#f3f4f6' },
  converted: { label: 'Converted', fg: '#1d4ed8', bg: '#dbeafe' },
  lost:      { label: 'Lost',      fg: '#6b7280', bg: '#f3f4f6' },
  withdrawn: { label: 'Withdrawn', fg: '#6b7280', bg: '#f3f4f6' },
};

const EMPTY = {
  partner_id: '', customer_name: '', contact_name: '', contact_email: '',
  region: '', deal_description: '', estimated_value: '', expected_close_date: '',
  protection_days: 90,
};

const money = (n) => n == null ? '—'
  : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const fmt = (d) => d ? new Date(d).toLocaleDateString('en-GB',
  { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const card = { background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4' };
const input = {
  width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
  fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const btn = {
  padding: '7px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff',
  cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#374151',
  display: 'inline-flex', gap: 6, alignItems: 'center',
};
const chip = (active) => ({
  padding: '7px 12px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', borderColor: active ? '#6B3FDB' : '#e5e7eb',
  background: active ? '#6B3FDB' : '#fff', color: active ? '#fff' : '#374151',
});

export default function DealRegistrations() {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [partners, setPartners] = useState([]);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [availability, setAvailability] = useState(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    const params = { limit: 200 };
    if (status !== 'all') params.status = status;
    if (search) params.search = search;
    Promise.all([
      api.get('/sales/deal-registrations', { params }),
      api.get('/sales/deal-registrations/summary'),
    ])
      .then(([list, sum]) => {
        setRows(Array.isArray(list.data) ? list.data : []);
        setSummary(sum.data || null);
        setDenied(false);
      })
      .catch(err => {
        if (err.response?.status === 403) { setDenied(true); setRows([]); }
        else toast.error(err.response?.data?.error || 'Could not load registrations');
      })
      .finally(() => setLoading(false));
  }, [status, search, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/sales/partners', { params: { limit: 200 } })
      .then(r => setPartners(r.data?.data || r.data || []))
      .catch(() => setPartners([]));
  }, []);

  /** Check the customer as the partner types — the answer that saves the work. */
  const checkCustomer = async (name) => {
    if (!name || name.trim().length < 3) { setAvailability(null); return; }
    try {
      const { data } = await api.get('/sales/deal-registrations/check',
        { params: { customer_name: name } });
      setAvailability(data);
    } catch { setAvailability(null); }
  };

  const submit = async () => {
    if (!form.partner_id || !form.customer_name) return;
    setSaving(true);
    try {
      const { data } = await api.post('/sales/deal-registrations', {
        ...form,
        estimated_value: form.estimated_value === '' ? null : Number(form.estimated_value),
        expected_close_date: form.expected_close_date || null,
        protection_days: Number(form.protection_days) || 90,
      });
      setShowForm(false); setForm(EMPTY); setAvailability(null); load();
      // The warning is the useful part when a customer is already claimed.
      if (data?.warning) toast.error(data.warning);
      else toast.success(`${data.registration_number} registered — awaiting approval`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not register that deal');
    } finally { setSaving(false); }
  };

  const act = async (row, verb) => {
    let reason;
    if (verb === 'reject') {
      reason = window.prompt('Why is this registration being rejected?');
      if (reason === null) return;
    }
    try {
      const { data } = await api.post(`/sales/deal-registrations/${row.id}/${verb}`, { reason });
      toast.success(`${row.registration_number} — ${STATES[data.status]?.label ?? data.status}`);
      load();
    } catch (err) {
      // The server explains conflicts and role requirements precisely; replacing
      // that with "action failed" is what makes a refusal feel like a bug.
      toast.error(err.response?.data?.error || `${verb} failed`);
    }
  };

  return (
    <PageShell dock={
      <PageHero
        icon={Handshake}
        eyebrow="Partner Channel"
        title="Deal Registration"
        actions={<button className="plh-cta" onClick={() => setShowForm(true)} disabled={denied}>
          <Plus size={15} /> Register a Deal
        </button>}
      />
    }>
      {summary && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <button onClick={() => setStatus('all')} style={chip(status === 'all')}>
            All {summary.total}
          </button>
          {['submitted', 'approved', 'rejected', 'expired', 'converted'].map(k => (
            <button key={k} onClick={() => setStatus(k)} style={chip(status === k)}>
              {STATES[k].label} {summary[k === 'submitted' ? 'pending' : k] ?? 0}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12, color: '#6b7280' }}>
            <ShieldCheck size={12} style={{ verticalAlign: -2 }} /> {money(summary.protected_value)} protected
          </span>
          {summary.expiring_soon > 0 && (
            <span style={{ padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                           background: '#fef3c7', color: '#b45309', alignSelf: 'center' }}>
              {summary.expiring_soon} expiring within 14 days
            </span>
          )}
        </div>
      )}

      <div style={{ position: 'relative', marginBottom: 20, maxWidth: 420 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%',
                                   transform: 'translateY(-50%)', color: '#9ca3af' }} />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search customer or description..."
          style={{ ...input, paddingLeft: 32 }} />
      </div>

      {denied ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' }}>
          <Handshake size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#6b7280', margin: 0, fontWeight: 600 }}>
            You do not have access to deal registration
          </p>
        </div>
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' }}>
          <Handshake size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: '0 0 16px' }}>No registrations yet</p>
          <button onClick={() => setShowForm(true)}
            style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none',
                     borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Register the First Deal
          </button>
        </div>
      ) : (
        <div style={{ ...card, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', background: '#fafaff' }}>
                {['Reference', 'Partner', 'Customer', 'Value', 'State', 'Protection', ''].map(h => (
                  <th key={h} style={{ padding: '10px 12px', fontWeight: 600, fontSize: 11,
                                       whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const st = STATES[r.status] || STATES.submitted;
                return (
                  <tr key={r.id} style={{ borderTop: '1px solid #f5f3ff' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {r.registration_number}
                    </td>
                    <td style={{ padding: '10px 12px' }}>{r.partner_name}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontWeight: 600, color: '#1f2937' }}>{r.customer_name}</div>
                      {r.deal_description && (
                        <div style={{ color: '#9ca3af', fontSize: 11 }}>{r.deal_description}</div>
                      )}
                      {r.rejected_reason && (
                        <div style={{ color: '#b91c1c', fontSize: 11 }}>Rejected: {r.rejected_reason}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {money(r.estimated_value)}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ background: st.bg, color: st.fg, padding: '2px 8px',
                                     borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
                        {st.label}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: '#6b7280' }}>
                      {r.status === 'approved' ? (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center',
                                       color: r.expiring_soon ? '#b45309' : '#6b7280',
                                       fontWeight: r.expiring_soon ? 700 : 400 }}>
                          <Clock size={11} />
                          {r.days_remaining != null ? `${r.days_remaining} days left` : fmt(r.expires_at)}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {r.status === 'submitted' && (
                        <>
                          <button style={btn} onClick={() => act(r, 'approve')}>
                            <Check size={12} /> Approve
                          </button>
                          <button style={{ ...btn, marginLeft: 6 }} onClick={() => act(r, 'reject')}>
                            <Ban size={12} /> Reject
                          </button>
                        </>
                      )}
                      {r.status === 'approved' && (
                        <span style={{ fontSize: 11, color: '#9ca3af', display: 'inline-flex',
                                       gap: 4, alignItems: 'center' }}>
                          <Link2 size={11} /> link an opportunity to convert
                        </span>
                      )}
                      {['rejected', 'expired'].includes(r.status) && (
                        <button style={btn} onClick={() => act(r, 'resubmit')}>Resubmit</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 560,
                        maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
                        boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                Register a Deal
              </h2>
              <button onClick={() => { setShowForm(false); setAvailability(null); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}>
                <X size={20} />
              </button>
            </div>

            <div style={{ display: 'grid', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                marginBottom: 4 }}>Partner *</label>
                <select value={form.partner_id} style={input}
                  onChange={e => setForm(p => ({ ...p, partner_id: e.target.value }))}>
                  <option value="">Select a partner…</option>
                  {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                marginBottom: 4 }}>End customer *</label>
                <input value={form.customer_name} style={input}
                  placeholder="The company the partner is selling to"
                  onChange={e => { setForm(p => ({ ...p, customer_name: e.target.value })); }}
                  onBlur={e => checkCustomer(e.target.value)} />
                {availability && (
                  <p style={{ margin: '6px 0 0', fontSize: 12, display: 'flex', gap: 6,
                              alignItems: 'flex-start',
                              color: availability.available ? '#047857' : '#b45309' }}>
                    {availability.available
                      ? <><ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 1 }} /> Available — no partner holds this customer.</>
                      : <><AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                          {availability.conflict?.partner_name} holds this customer until{' '}
                          {fmt(availability.conflict?.expires_at)}. You can still submit, but it cannot be approved while that stands.</>}
                  </p>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                  marginBottom: 4 }}>Estimated value</label>
                  <input type="number" min="0" value={form.estimated_value} style={input}
                    onChange={e => setForm(p => ({ ...p, estimated_value: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                  marginBottom: 4 }}>Expected close</label>
                  <input type="date" value={form.expected_close_date} style={input}
                    onChange={e => setForm(p => ({ ...p, expected_close_date: e.target.value }))} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                  marginBottom: 4 }}>Region</label>
                  <input value={form.region} style={input}
                    onChange={e => setForm(p => ({ ...p, region: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                  marginBottom: 4 }}>Protection (days)</label>
                  <input type="number" min="1" max="365" value={form.protection_days} style={input}
                    onChange={e => setForm(p => ({ ...p, protection_days: e.target.value }))} />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                marginBottom: 4 }}>What is the deal?</label>
                <textarea rows={4} value={form.deal_description} style={{ ...input, resize: 'vertical' }}
                  onChange={e => setForm(p => ({ ...p, deal_description: e.target.value }))} />
              </div>

              <p style={{ margin: 0, fontSize: 11, color: '#9ca3af' }}>
                Protection starts when the registration is approved, not when it is submitted, and
                someone other than the submitter has to approve it.
              </p>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => { setShowForm(false); setAvailability(null); }}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8,
                         background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={submit} disabled={saving || !form.partner_id || !form.customer_name}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none',
                         borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                         opacity: (saving || !form.partner_id || !form.customer_name) ? .6 : 1 }}>
                {saving ? 'Registering…' : 'Register'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
