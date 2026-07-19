import { Megaphone, ChevronRight } from 'lucide-react';
import { useAnnouncements } from '@/hooks/useAnnouncements';

const PRIORITY_DOT = { Urgent: '#ef4444', Important: '#f59e0b', Normal: '#9ca3af' };

/**
 * AnnouncementsPanel — compact widget for Home / dashboard pages.
 *
 * Props:
 *   setPage      — for navigating to full announcements page
 *   limit        — max items to show (default 4)
 *   items        — pre-fetched items from a parent page (skips own network call)
 *   loading      — loading state supplied by the parent
 *
 * When `items` is provided the hook fetch is bypassed entirely, so pages that
 * already call /announcements/active don't trigger a duplicate request.
 */
export default function AnnouncementsPanel({ setPage, limit = 4, items: itemsProp, loading: loadingProp }) {
  const { items: hookItems, loading: hookLoading } = useAnnouncements(limit);

  const items   = itemsProp  !== undefined ? itemsProp  : hookItems;
  const loading = loadingProp !== undefined ? loadingProp : hookLoading;

  const unread = items.filter(a => !a.is_read).length;

  return (
    <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #f3f4f6' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Megaphone size={15} color="#6366f1" />
          <span style={{ fontWeight: 700, fontSize: '14px' }}>Announcements</span>
          {unread > 0 && (
            <span style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '20px', padding: '1px 7px', fontSize: '10px', fontWeight: 700 }}>{unread}</span>
          )}
        </div>
        {setPage && (
          <button onClick={() => setPage('Announcements')}
            style={{ border: 'none', background: 'none', color: '#6366f1', fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '2px' }}>
            View all <ChevronRight size={12} />
          </button>
        )}
      </div>
      <div>
        {loading ? (
          <p style={{ margin: 0, padding: '16px', fontSize: '13px', color: '#9ca3af', textAlign: 'center' }}>Loading…</p>
        ) : items.length === 0 ? (
          <div style={{ color: '#9ca3af', fontSize: '13px', padding: '16px', textAlign: 'center' }}>
            Nothing to show
          </div>
        ) : items.map((ann, idx) => (
          <div key={ann.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 16px',
            borderBottom: idx < items.length - 1 ? '1px solid #f9fafb' : 'none',
            background: ann.is_read ? '#fff' : '#fafbff' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: PRIORITY_DOT[ann.priority] || '#9ca3af', flexShrink: 0, marginTop: '5px' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: ann.is_read ? 400 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ann.title}</div>
              <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>{ann.created_at}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
