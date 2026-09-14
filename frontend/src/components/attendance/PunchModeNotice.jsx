import { Fingerprint, ScanFace, AlertCircle } from 'lucide-react';

/**
 * PunchModeNotice — what a non-field employee sees where the Clock In button
 * used to be.
 *
 * In-app punching is for field employees only; everyone else records
 * attendance on the office face / biometric terminal, which syncs into
 * attendance_records on its own. Rendering this instead of a disabled button
 * makes the reason legible — a greyed-out button reads as "broken", not as
 * "use the device by the door".
 *
 * Shared by all four self-service clock surfaces so the wording stays in one
 * place.
 */
export default function PunchModeNotice({ reason, message, compact = false }) {
  const unlinked = reason === 'employee_not_linked' || reason === 'employee_not_found';
  const Icon = unlinked ? AlertCircle : ScanFace;

  const text = message || (unlinked
    ? 'Your login is not linked to an employee record. Ask HR to link it.'
    : 'Record your attendance at the office face / biometric device.');

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        padding: compact ? '8px 10px' : '10px 12px',
        borderRadius: 8,
        border: `1px solid ${unlinked ? '#fde68a' : '#e9e4ff'}`,
        background: unlinked ? '#fffbeb' : '#f8f6ff',
        color: unlinked ? '#92400e' : '#4b5563',
        fontSize: compact ? 12 : 12.5,
        lineHeight: 1.5,
      }}
    >
      <Icon size={15} style={{ flexShrink: 0, marginTop: 1, color: unlinked ? '#d97706' : '#7c3aed' }} />
      <span>
        {text}
        {!unlinked && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6, color: '#7c3aed', fontWeight: 600 }}>
            <Fingerprint size={13} /> Face / biometric
          </span>
        )}
      </span>
    </div>
  );
}
