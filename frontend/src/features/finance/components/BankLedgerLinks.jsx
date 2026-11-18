// Bank Accounts → Ledger links (§275).
//
// Each company bank account must point at a ledger account before anything can
// be paid from it (F&F settlements, supplier payment batches) and before its
// balance can come from the ledger. The link is Finance's approved payment
// account mapping (PUT /finance/accounting/payment-gl-mapping, finance:approve);
// this panel is the screen for it. "Create ledger" makes a ledger account of
// its own for a bank account when the chart has none (Asset, sub-type bank).
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

const box = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20, marginBottom: 16 };
const sel = { width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, background: '#fff' };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 12, color: '#6b7280', borderBottom: '1px solid #f0f0f4' };
const td = { padding: '10px', fontSize: 13, borderBottom: '1px solid #f8f8fc', verticalAlign: 'middle' };

export default function BankLedgerLinks({ onChanged }) {
  const [opts, setOpts] = useState(null);
  const [error, setError] = useState('');
  const [payable, setPayable] = useState('');
  const [links, setLinks] = useState({});        // bank account id → ledger code ('' = not linked)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);           // { type, text, problems? }

  const load = useCallback(async () => {
    setError('');
    try {
      const { data } = await api.get('/finance/accounting/bank-ledger-options');
      setOpts(data);
      const m = data.mapping || {};
      setPayable(m.payable?.code || (data.payable_accounts.find(a => a.code === '2001') ? '2001' : data.payable_accounts[0]?.code || ''));
      setLinks(Object.fromEntries(data.bank_accounts.map(b => [b.id, m.bankLedgers?.[String(b.id)]?.code || b.linked_code || ''])));
    } catch (e) {
      setError(e?.response?.status === 403 ? 'You need Finance access to see ledger links.' : (e?.response?.data?.error || 'Ledger links could not be loaded.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const createLedger = async (bank) => {
    setBusy(true); setMsg(null);
    try {
      const { data } = await api.post('/finance/accounting/bank-ledger-accounts', { bank_account_id: bank.id });
      await load();
      setLinks(l => ({ ...l, [bank.id]: data.account.code }));
      setMsg({ type: 'ok', text: `Ledger ${data.account.code} "${data.account.name}" created for ${bank.account_name}. Approve the links to put it in use.` });
    } catch (e) {
      setMsg({ type: 'error', text: e?.response?.data?.error || 'The ledger account could not be created.' });
    } finally { setBusy(false); }
  };

  const approve = async () => {
    const bank_ledgers = Object.fromEntries(Object.entries(links).filter(([, code]) => code));
    if (!Object.keys(bank_ledgers).length) { setMsg({ type: 'error', text: 'Choose a ledger account for at least one bank account.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.put('/finance/accounting/payment-gl-mapping', { accounts_payable_account_code: payable, bank_ledgers });
      await load();
      onChanged?.();
      setMsg({ type: 'ok', text: 'Ledger links approved. Payments can now be made from the linked accounts.' });
    } catch (e) {
      const d = e?.response?.data || {};
      setMsg({ type: 'error', text: e?.response?.status === 403 ? 'Approving ledger links needs Finance approval rights.' : (d.message || d.error || 'The links were not approved.'), problems: d.problems });
    } finally { setBusy(false); }
  };

  if (error) return <div style={box} role="alert">{error}</div>;
  if (!opts) return <div style={box}>Loading ledger links…</div>;

  const m = opts.mapping || {};
  const status = m.status === 'approved' ? { text: 'Approved', bg: '#dcfce7', fg: '#166534' }
    : m.status === 'invalid' ? { text: 'Needs attention', bg: '#fee2e2', fg: '#b91c1c' }
      : { text: 'Not set up', bg: '#fef3c7', fg: '#92400e' };

  return (
    <div>
      <div style={box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>Ledger links</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
              Pick the ledger account each bank account posts to. Payments (F&amp;F settlements, supplier payments) are refused from an account with no approved link.
            </p>
          </div>
          <span style={{ padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: status.bg, color: status.fg }}>{status.text}</span>
        </div>
        {m.status === 'invalid' && m.problems?.length > 0 && (
          <ul style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: 12, color: '#b91c1c' }}>{m.problems.map(p => <li key={p}>{p}</li>)}</ul>
        )}
        {m.approved_at && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>Last approved {new Date(m.approved_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}.</div>
        )}
      </div>

      <div style={box}>
        {opts.bank_accounts.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>No active bank account. Add the company's bank account on the Accounts tab first.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Bank account</th><th style={th}>Ledger account</th><th style={th} /></tr></thead>
            <tbody>
              {opts.bank_accounts.map(b => (
                <tr key={b.id}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{b.account_name}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{[b.bank_name, b.last4 && `••${b.last4}`, b.ifsc_code].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td style={{ ...td, width: '45%' }}>
                    <label htmlFor={`bl-${b.id}`} style={{ position: 'absolute', left: -9999 }}>Ledger for {b.account_name}</label>
                    <select id={`bl-${b.id}`} value={links[b.id] || ''} style={sel}
                      onChange={e => setLinks(l => ({ ...l, [b.id]: e.target.value }))}>
                      <option value="">— Not linked —</option>
                      {opts.bank_ledgers.map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                    </select>
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={() => createLedger(b)}>Create ledger</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 360px)', gap: 6, marginTop: 16 }}>
          <label htmlFor="bl-payable" style={{ fontSize: 12, color: '#6b7280' }}>Accounts payable (supplier payments post against it)</label>
          <select id="bl-payable" value={payable} onChange={e => setPayable(e.target.value)} style={sel}>
            <option value="">— Choose —</option>
            {opts.payable_accounts.map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </div>

        {msg && (
          <div role={msg.type === 'error' ? 'alert' : 'status'} style={{ marginTop: 14, padding: '8px 12px', borderRadius: 8, fontSize: 13,
            background: msg.type === 'error' ? '#fee2e2' : '#dcfce7', color: msg.type === 'error' ? '#b91c1c' : '#166534' }}>
            {msg.text}
            {msg.problems?.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{msg.problems.map(p => <li key={p}>{p}</li>)}</ul>}
          </div>
        )}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="pulse-btn-primary" disabled={busy || !opts.bank_accounts.length} onClick={approve}>
            {busy ? 'Saving…' : 'Approve links'}
          </button>
        </div>
      </div>
    </div>
  );
}
