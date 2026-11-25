import { useCallback, useEffect, useState } from 'react';
import { FileText, Eye, Send, ExternalLink, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { openEmployeeFile } from '@/features/employees/shared/employeeFiles';

/**
 * Joining letters for one hire (owner 18 Nov 26).
 *
 * The candidate got the offer by e-mail only. Here HR issues the offer letter,
 * appointment letter and confidentiality letter. Issuing files the PDF on the
 * employee record — the same Offer / Appointment / Confidentiality Letter slots
 * as Add / Edit Employee → Upload Documents, named "<EMP code>_<Name>_<Letter>".
 * A signed copy can be uploaded over it there. Backend: /onboarding/letters
 * (HR only — the letters show the salary), recruitment/joiningLetters.js.
 */
export default function JoiningLetters({ employeeId, onToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const toast = onToast || (() => {});

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get(`/onboarding/letters/${employeeId}`);
      // Anything without a letters list is treated as a failed load, so an
      // odd response cannot take down the page this card sits on.
      if (!Array.isArray(res?.data?.letters)) throw new Error('bad response');
      setData(res.data);
    } catch (e) {
      setData(null);
      setError(e?.response?.status === 403
        ? 'HR issues the joining letters. You can see the checklist below.'
        : (e?.response?.data?.message || 'The joining letters could not be loaded.'));
    }
  }, [employeeId]);
  useEffect(() => { load(); }, [load]);

  const preview = async (l) => {
    setBusy(`p${l.type}`);
    try {
      const res = await api.get(`/onboarding/letters/${employeeId}/${l.type}/preview`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      toast(await blobMessage(e) || 'Could not build the letter', 'error');
    } finally { setBusy(null); }
  };

  const issue = async (l) => {
    if (l.file_url && !window.confirm(
      `${l.label} is already on ${data?.name}'s record${l.source === 'uploaded' ? ' (uploaded — possibly the signed copy)' : ''}. ` +
      'Issuing again replaces it on the record (earlier issued copies are kept in the history). Continue?')) return;
    setBusy(`i${l.type}`);
    try {
      await api.post(`/onboarding/letters/${employeeId}/${l.type}`);
      toast(`${l.label} issued and saved to ${data?.name}'s documents`);
      load();
    } catch (e) {
      toast(e?.response?.data?.message || 'Could not issue the letter', 'error');
    } finally { setBusy(null); }
  };

  const view = async (l) => {
    const msg = await openEmployeeFile(l.file_url);
    if (msg) toast(msg, 'error');
  };

  return (
    <section data-testid="joining-letters" style={{ border: '1px solid #eef0f4', borderRadius: 10, padding: 14, marginBottom: 16, background: '#fcfcfe' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <strong style={{ fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FileText size={15} color="var(--color-primary, #6B3FDB)" /> Joining letters
        </strong>
        <button type="button" className="pulse-btn-secondary" onClick={load} style={{ fontSize: 12 }}><RefreshCw size={12} /> Refresh</button>
      </div>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
        The offer went by e-mail only. Issue the letters here; each is saved to the employee&apos;s documents
        (Edit Employee → Upload Documents), where the signed copy can be uploaded over it.
      </p>
      {error ? <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>{error}</p>
        : !data ? <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>Loading…</p>
        : data.letters.map(l => (
          <div key={l.type} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid #f3f4f6', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{l.label}</div>
              <div style={{ fontSize: 12, color: l.file_url ? 'var(--color-success, #16a34a)' : '#9ca3af' }}>
                {l.source === 'issued' ? `Issued ${fmtDate(l.last_issued_at)}${l.last_issued_by ? ` by ${l.last_issued_by}` : ''}${l.times_issued > 1 ? ` · issued ${l.times_issued} times` : ''}`
                  : l.source === 'uploaded' ? 'On file (uploaded on the employee record)'
                  : l.blocked_reason || 'Not issued yet'}
              </div>
            </div>
            {l.file_url && (
              <button type="button" className="pulse-btn-secondary" style={{ fontSize: 12 }} onClick={() => view(l)}>
                <ExternalLink size={12} /> View on file
              </button>
            )}
            <button type="button" className="pulse-btn-secondary" style={{ fontSize: 12 }} disabled={!l.can_issue || busy === `p${l.type}`} onClick={() => preview(l)}>
              <Eye size={12} /> Preview
            </button>
            <button type="button" className="pulse-btn-primary" style={{ fontSize: 12 }} disabled={!l.can_issue || busy === `i${l.type}`}
                    title={l.blocked_reason || undefined} onClick={() => issue(l)}>
              <Send size={12} /> {busy === `i${l.type}` ? 'Issuing…' : l.file_url ? 'Issue again' : 'Issue'}
            </button>
          </div>
        ))}
    </section>
  );
}

// An error on a blob request arrives as a Blob; read the JSON message out of it.
async function blobMessage(e) {
  try {
    const d = e?.response?.data;
    if (d instanceof Blob) return JSON.parse(await d.text())?.message;
    return d?.message;
  } catch { return null; }
}
