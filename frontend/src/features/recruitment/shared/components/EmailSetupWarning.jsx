import { AlertTriangle } from 'lucide-react';

/**
 * Shown when the company has no outgoing e-mail (SMTP) set up: until then
 * every candidate e-mail — offer letter, interview invite, welcome — is
 * skipped without anyone noticing (the server only logs it).
 */
export default function EmailSetupWarning({ show }) {
  if (!show) return null;
  return (
    <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#991b1b', fontSize: 13, marginBottom: 14 }}>
      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>
        <strong>Candidates are not getting e-mails.</strong> Outgoing e-mail (SMTP) is not set up, so offer letters,
        interview invites and welcome e-mails are not sent. An administrator sets it up in Platform &amp; Integrations → Integrations → Email / SMTP.
      </span>
    </div>
  );
}
