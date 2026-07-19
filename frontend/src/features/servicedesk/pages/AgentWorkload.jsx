// ─── AgentWorkload.jsx ────────────────────────────────────────────────────────
import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { Users } from 'lucide-react';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899'];

export default function AgentWorkload() {
  const [teams,   setTeams]   = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/servicedesk/stats')
      .then(r => setTeams(Array.isArray(r.data?.byTeam) ? r.data.byTeam : []))
      .catch(() => setTeams([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Team Workload</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>Ticket distribution across support teams</p>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : teams.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <Users size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af' }}>No tickets found. Create tickets and assign them to teams to see workload distribution.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {teams.map((t, i) => {
            const total   = parseInt(t?.count      ?? 0);
            const open    = parseInt(t?.open       ?? 0);
            const inProg  = parseInt(t?.in_progress ?? 0);
            const closed  = parseInt(t?.closed     ?? 0);
            const openPct = total > 0 ? Math.round((open / total) * 100) : 0;
            const color   = COLORS[i % COLORS.length];
            return (
              <div key={i} style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: '18px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, fontSize: 15, color: '#1f2937' }}>{t?.team ?? 'Unassigned'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: '#6b7280', fontWeight: 500 }}>{total} total</span>
                </div>
                <div style={{ display: 'flex', gap: 20, marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: '#6366f1', fontWeight: 600 }}>{open} open</span>
                  <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>{inProg} in progress</span>
                  <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>{closed} resolved / closed</span>
                </div>
                <div style={{ background: '#f3f4f6', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                  <div style={{ width: `${openPct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .3s' }} />
                </div>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '6px 0 0' }}>{openPct}% open rate</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
