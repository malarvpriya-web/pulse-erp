import { useState, useEffect } from 'react';
import api from '@/services/api/client';

const ago = ts => {
  if (!ts) return '';
  const m = Math.floor((Date.now() - new Date(ts)) / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export function AnnouncementsWidget({ data: propData }) {
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (propData?.announcements?.length) {
      setItems(propData.announcements);
      setLoading(false);
      return;
    }
    api.get('/announcements?limit=3')
      .then(r => {
        const d = r.data;
        setItems(Array.isArray(d) ? d : (d?.announcements || d?.data || []));
      })
      .catch(err => {
        setError(err?.response?.data?.error || 'Failed to load announcements');
      })
      .finally(() => setLoading(false));
  }, [propData]);


  const celebs = propData?.birthdays || propData?.anniversaries;

  if (error) {
    return (
      <div className="widget-data">
        <p style={{ color: '#dc2626', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
          {error}
        </p>
      </div>
    );
  }

  return (
    <div className="widget-data">
      {items.length === 0 && !celebs ? (
        <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'16px 0' }}>
          No announcements
        </p>
      ) : (
        <div className="announcement-list" style={{ gap:8 }}>
          {items.slice(0, 3).map((a, i) => {
            const isRead = a.is_read || a.read || false;
            return (
              <div key={i} className="announcement-item" style={{
                borderLeft: `3px solid ${isRead ? '#e5e7eb' : '#6B3FDB'}`,
                background: isRead ? '#f9fafb' : '#f5f3ff',
                gap:8, alignItems:'flex-start',
              }}>
                {/* unread dot */}
                {!isRead && (
                  <span style={{
                    width:7, height:7, borderRadius:'50%', background:'#6B3FDB',
                    flexShrink:0, marginTop:3,
                  }}/>
                )}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{
                    fontSize:13, fontWeight: isRead ? 500 : 700,
                    color:'#1f2937',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                  }}>{a.title}</div>
                  {a.body && (
                    <p style={{
                      fontSize:12, color:'#6b7280', margin:'3px 0 0',
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                    }}>{a.body}</p>
                  )}
                </div>
                <span className="announcement-date" style={{ fontSize:11, flexShrink:0, color:'#9ca3af' }}>
                  {ago(a.created_at || a.date)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {celebs && (
        <div className="celebrations" style={{ marginTop: items.length ? 10 : 0, fontSize:13 }}>
          {propData.birthdays    && <p style={{ margin:'5px 0' }}>🎂 <strong>Birthdays:</strong> {propData.birthdays}</p>}
          {propData.anniversaries && <p style={{ margin:'5px 0' }}>🎉 <strong>Work Anniversary:</strong> {propData.anniversaries}</p>}
        </div>
      )}
    </div>
  );
}

export default AnnouncementsWidget;
