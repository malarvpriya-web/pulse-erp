import { Eye } from 'lucide-react';

/**
 * ReadOnlyBanner — shown at the top of a page whose section an admin has
 * restricted to "View" on the Page Access screen. Signals that create/edit/
 * delete actions are disabled for the current user.
 */
export default function ReadOnlyBanner({ label = 'view-only access' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      margin: '0 0 16px', padding: '9px 14px',
      background: '#e0f2fe', border: '1px solid #bae6fd', borderRadius: 9,
      color: '#0369a1', fontSize: 13, fontWeight: 600, fontFamily: 'Inter, sans-serif',
    }}>
      <Eye size={15} />
      You have {label} on this page — editing is disabled by your administrator.
    </div>
  );
}
