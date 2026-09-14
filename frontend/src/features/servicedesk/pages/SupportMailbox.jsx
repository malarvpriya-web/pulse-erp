/**
 * SupportMailbox — email-to-case configuration and the inbound log.
 *
 * Two jobs:
 *   1. connect a mailbox, and show the ingest secret ONCE at the moment it is
 *      created (it is never retrievable afterwards);
 *   2. show every message that arrived, INCLUDING the ones that did not become a
 *      case. "The customer says they emailed us" is the question this page
 *      exists to answer, and a silent drop makes it unanswerable.
 *
 * With nothing configured it says so, rather than rendering an empty inbox that
 * looks like "no one has written to us".
 */
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Inbox, Plus, X, KeyRound, Copy, AlertTriangle, Mail, Power } from 'lucide-react';
import { PageHero, PageShell } from '@/components/pulse-ui';

const OUTCOMES = {
  created_ticket: { label: 'Opened a case', fg: '#047857', bg: '#d1fae5' },
  appended:       { label: 'Added to case', fg: '#1d4ed8', bg: '#dbeafe' },
  ignored:        { label: 'Ignored',       fg: '#6b7280', bg: '#f3f4f6' },
  rejected:       { label: 'Rejected',      fg: '#b91c1c', bg: '#fee2e2' },
  duplicate:      { label: 'Duplicate',     fg: '#6b7280', bg: '#f3f4f6' },
  received:       { label: 'Received',      fg: '#6b7280', bg: '#f3f4f6' },
};

const THREADED = {
  subject_token: 'case reference in the subject',
  in_reply_to:   'reply headers',
  heuristic:     'sender + subject match (a guess)',
};

const fmt = (d) => d ? new Date(d).toLocaleString('en-GB',
  { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const card = { background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4' };
const input = {
  width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
  fontSize: 13, outline: 'none', boxSizing: 'border-box',
};

export default function SupportMailbox() {
  const [mailboxes, setMailboxes] = useState([]);
  const [notice, setNotice] = useState(null);
  const [inbound, setInbound] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email_address: '', display_name: '', default_team: '', default_priority: 'Medium' });
  const [saving, setSaving] = useState(false);
  const [issued, setIssued] = useState(null);   // { email_address, secret } — shown once
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/support-mail/mailboxes'),
      api.get('/support-mail/inbound', { params: { limit: 200 } }),
      api.get('/support-mail/inbound/summary'),
    ])
      .then(([mb, inb, sum]) => {
        setMailboxes(mb.data?.data || []);
        setNotice(mb.data?.status || null);
        setInbound(Array.isArray(inb.data) ? inb.data : []);
        setSummary(sum.data || null);
        setDenied(false);
      })
      .catch(err => {
        if (err.response?.status === 403) { setDenied(true); setMailboxes([]); setInbound([]); }
        else toast.error(err.response?.data?.error || 'Could not load the mail settings');
      })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.email_address) return;
    setSaving(true);
    try {
      const { data } = await api.post('/support-mail/mailboxes', form);
      setShowForm(false);
      setForm({ email_address: '', display_name: '', default_team: '', default_priority: 'Medium' });
      // A secret comes back only when the mailbox was actually created — an
      // update leaves the existing one alone and returns none.
      if (data.ingest_secret) setIssued({ email: data.email_address, secret: data.ingest_secret });
      else toast.success(data.notice || 'Settings updated');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save the mailbox');
    } finally { setSaving(false); }
  };

  const rotate = async (mb) => {
    if (!window.confirm(`Rotate the secret for ${mb.email_address}? The current one stops working immediately.`)) return;
    try {
      const { data } = await api.post(`/support-mail/mailboxes/${mb.id}/rotate-secret`);
      setIssued({ email: data.email_address, secret: data.ingest_secret });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not rotate the secret'); }
  };

  const deactivate = async (mb) => {
    if (!window.confirm(`Stop receiving mail at ${mb.email_address}?`)) return;
    try {
      await api.delete(`/support-mail/mailboxes/${mb.id}`);
      toast.success(`${mb.email_address} deactivated — the history is kept`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not deactivate'); }
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text)
      .then(() => toast.success('Copied'))
      .catch(() => toast.error('Could not copy — select the text and copy it manually'));
  };

  return (
    <PageShell dock={
      <PageHero
        icon={Inbox}
        eyebrow="Service Desk"
        title="Email to Case"
        actions={<button className="plh-cta" onClick={() => setShowForm(true)} disabled={denied}>
          <Plus size={15} /> Connect a Mailbox
        </button>}
      />
    }>
      {denied ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' }}>
          <Inbox size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#6b7280', margin: 0, fontWeight: 600 }}>
            You do not have access to the service desk mail settings
          </p>
        </div>
      ) : (
        <>
          {notice && (
            <div style={{ ...card, borderColor: '#fde68a', background: '#fffbeb', padding: '12px 16px',
                          marginBottom: 16, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <AlertTriangle size={16} color="#b45309" style={{ flexShrink: 0, marginTop: 2 }} />
              <p style={{ margin: 0, fontSize: 12, color: '#92400e' }}>{notice}</p>
            </div>
          )}

          {summary && summary.total > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              {[['Cases opened', summary.created], ['Replies threaded', summary.appended],
                ['Ignored', summary.ignored], ['Rejected', summary.rejected]].map(([label, n]) => (
                <div key={label} style={{ ...card, padding: '10px 16px', minWidth: 120 }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#1f2937',
                                fontVariantNumeric: 'tabular-nums' }}>{n}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
                </div>
              ))}
              {summary.threaded_by_guess > 0 && (
                <div style={{ ...card, padding: '10px 16px', minWidth: 160, borderColor: '#fde68a' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#b45309',
                                fontVariantNumeric: 'tabular-nums' }}>{summary.threaded_by_guess}</div>
                  {/* Worth surfacing: these were matched on sender+subject rather
                      than a reference, so they are the ones that could be wrong. */}
                  <div style={{ fontSize: 11, color: '#92400e' }}>threaded by a guess</div>
                </div>
              )}
            </div>
          )}

          <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 8px' }}>Mailboxes</h3>
          {mailboxes.length === 0 ? (
            <div style={{ ...card, padding: 32, textAlign: 'center', marginBottom: 24 }}>
              <Mail size={32} color="#d1d5db" style={{ marginBottom: 8 }} />
              <p style={{ color: '#9ca3af', margin: 0, fontSize: 13 }}>No mailbox connected</p>
            </div>
          ) : (
            <div style={{ ...card, marginBottom: 24, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#6b7280', background: '#fafaff' }}>
                    {['Address', 'Routes to', 'Ingest', 'Status', ''].map(h => (
                      <th key={h} style={{ padding: '10px 12px', fontWeight: 600, fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mailboxes.map(mb => (
                    <tr key={mb.id} style={{ borderTop: '1px solid #f5f3ff' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                        {mb.email_address}
                        {mb.display_name && (
                          <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 400 }}>{mb.display_name}</div>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px', color: '#6b7280' }}>
                        {mb.default_team || 'unassigned'} · {mb.default_priority}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ background: mb.ingest_configured ? '#d1fae5' : '#fee2e2',
                                       color: mb.ingest_configured ? '#047857' : '#b91c1c',
                                       padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
                          {mb.ingest_configured ? 'Secret set' : 'No secret'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', color: mb.is_active ? '#047857' : '#9ca3af' }}>
                        {mb.is_active ? 'Active' : 'Inactive'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button onClick={() => rotate(mb)}
                          style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #e5e7eb',
                                   background: '#fff', cursor: 'pointer', fontSize: 12,
                                   display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                          <KeyRound size={12} /> Rotate
                        </button>
                        {mb.is_active && (
                          <button onClick={() => deactivate(mb)}
                            style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #e5e7eb',
                                     background: '#fff', cursor: 'pointer', fontSize: 12, marginLeft: 6,
                                     display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                            <Power size={12} /> Stop
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 8px' }}>
            Everything that arrived
          </h3>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
          ) : inbound.length === 0 ? (
            <div style={{ ...card, padding: 32, textAlign: 'center' }}>
              <p style={{ color: '#9ca3af', margin: 0, fontSize: 13 }}>
                No mail has been received yet.
              </p>
            </div>
          ) : (
            <div style={{ ...card, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#6b7280', background: '#fafaff' }}>
                    {['Received', 'From', 'Subject', 'Outcome', 'Case'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', fontWeight: 600, fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {inbound.map(e => {
                    const o = OUTCOMES[e.status] || OUTCOMES.received;
                    return (
                      <tr key={e.id} style={{ borderTop: '1px solid #f5f3ff' }}>
                        <td style={{ padding: '10px 12px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                          {fmt(e.received_at)}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          {e.from_name && <div style={{ fontWeight: 600 }}>{e.from_name}</div>}
                          <div style={{ color: '#9ca3af', fontSize: 11 }}>{e.from_email}</div>
                        </td>
                        <td style={{ padding: '10px 12px' }}>{e.subject || '(no subject)'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ background: o.bg, color: o.fg, padding: '2px 8px',
                                         borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
                            {o.label}
                          </span>
                          {e.threaded_by && (
                            <div style={{ color: '#9ca3af', fontSize: 10, marginTop: 3 }}>
                              matched by {THREADED[e.threaded_by] || e.threaded_by}
                            </div>
                          )}
                          {e.reject_reason && (
                            <div style={{ color: '#b91c1c', fontSize: 10, marginTop: 3 }}>{e.reject_reason}</div>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                          {e.ticket_number
                            ? <span style={{ fontWeight: 600 }}>{e.ticket_number}
                                <span style={{ color: '#9ca3af', fontWeight: 400 }}> · {e.ticket_status}</span>
                              </span>
                            : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {issued && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1001,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 560, maxWidth: '100%' }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 6px' }}>Copy this secret now</h2>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>
              It is not stored in a way anyone can read back, so this is the only time it is shown.
              Your mail provider must send it as the <code>X-Ingest-Secret</code> header when posting
              to <code>/api/support-mail/ingest</code> for <strong>{issued.email}</strong>.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={issued.secret} style={{ ...input, fontFamily: 'monospace' }}
                onFocus={e => e.target.select()} />
              <button onClick={() => copy(issued.secret)}
                style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #e5e7eb',
                         background: '#fff', cursor: 'pointer', display: 'inline-flex', gap: 6,
                         alignItems: 'center', fontSize: 13, whiteSpace: 'nowrap' }}>
                <Copy size={14} /> Copy
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setIssued(null)}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none',
                         borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                I have copied it
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 520, maxWidth: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                Connect a Mailbox
              </h2>
              <button onClick={() => setShowForm(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}>
                <X size={20} />
              </button>
            </div>
            <div style={{ display: 'grid', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                marginBottom: 4 }}>Address *</label>
                <input value={form.email_address} style={input} placeholder="support@yourcompany.com"
                  onChange={e => setForm(p => ({ ...p, email_address: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                marginBottom: 4 }}>Display name</label>
                <input value={form.display_name} style={input} placeholder="Customer Support"
                  onChange={e => setForm(p => ({ ...p, display_name: e.target.value }))} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                  marginBottom: 4 }}>Route to team</label>
                  <input value={form.default_team} style={input}
                    onChange={e => setForm(p => ({ ...p, default_team: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151',
                                  marginBottom: 4 }}>Default priority</label>
                  <select value={form.default_priority} style={input}
                    onChange={e => setForm(p => ({ ...p, default_priority: e.target.value }))}>
                    {['Low', 'Medium', 'High', 'Critical'].map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
              </div>
              <p style={{ margin: 0, fontSize: 11, color: '#9ca3af' }}>
                Connecting a mailbox does not start collecting mail on its own — point your mail
                provider's webhook at the ingest endpoint using the secret shown next.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowForm(false)}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8,
                         background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={save} disabled={saving || !form.email_address}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none',
                         borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                         opacity: (saving || !form.email_address) ? .6 : 1 }}>
                {saving ? 'Saving…' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
