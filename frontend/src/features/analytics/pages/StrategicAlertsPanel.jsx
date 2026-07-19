// frontend/src/features/analytics/pages/StrategicAlertsPanel.jsx
// Phase 49H — War Room (Section 14 + 16) — Strategic Alerts requiring CEO acknowledgement
import { useState } from 'react';
import {
  AlertTriangle, CheckCircle, Bell, Users, Package,
  Briefcase, IndianRupee, FileText, RefreshCw, Shield,
} from 'lucide-react';

const C = {
  primary: '#6B3FDB', green: '#16a34a', red: '#dc2626',
  amber: '#d97706', blue: '#2563eb', border: '#e9e4ff',
};

const CATEGORY_CFG = {
  customer:   { icon: Users,     label: 'Customer',       color: C.blue },
  vendor:     { icon: Package,   label: 'Vendor',         color: C.amber },
  project:    { icon: Briefcase, label: 'Project',        color: C.primary },
  collection: { icon: IndianRupee,label: 'Collection',     color: C.red },
  amc:        { icon: FileText,  label: 'AMC',            color: '#0891b2' },
  quality:    { icon: Shield,    label: 'Quality/NCR',    color: '#db2777' },
};

const SEVERITY_CFG = {
  red:   { bg: '#fff1f2', border: '#fca5a5', color: C.red,   dot: '#dc2626', label: 'Red Alert' },
  amber: { bg: '#fffbeb', border: '#fcd34d', color: '#92400e', dot: C.amber, label: 'Warning' },
};

function AlertCard({ alert, onAck, isAcknowledged }) {
  const sevCfg = SEVERITY_CFG[alert.severity] || SEVERITY_CFG.amber;
  const catCfg = CATEGORY_CFG[alert.category] || { icon: Bell, label: alert.category, color: C.primary };
  const CatIcon = catCfg.icon;

  return (
    <div style={{
      background: isAcknowledged ? '#f9fafb' : sevCfg.bg,
      border: `1px solid ${isAcknowledged ? '#e5e7eb' : sevCfg.border}`,
      borderRadius: 12, padding: '14px 16px',
      opacity: isAcknowledged ? 0.65 : 1,
      transition: 'opacity .2s',
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {/* Severity dot */}
        <div style={{
          width: 10, height: 10, borderRadius: '50%', background: isAcknowledged ? '#9ca3af' : sevCfg.dot,
          flexShrink: 0, marginTop: 5,
          boxShadow: isAcknowledged ? 'none' : `0 0 0 3px ${sevCfg.dot}30`,
        }} />

        <div style={{ flex: 1 }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <CatIcon size={12} color={catCfg.color} />
              <span style={{ fontSize: 11, fontWeight: 700, color: catCfg.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {catCfg.label}
              </span>
            </div>
            <span style={{ padding: '1px 7px', borderRadius: 5, fontSize: 10, fontWeight: 700, background: isAcknowledged ? '#e5e7eb' : `${sevCfg.dot}20`, color: isAcknowledged ? '#9ca3af' : sevCfg.color }}>
              {isAcknowledged ? 'ACKNOWLEDGED' : sevCfg.label.toUpperCase()}
            </span>
          </div>

          {/* Alert type */}
          <div style={{ fontSize: 13, fontWeight: 700, color: isAcknowledged ? '#9ca3af' : '#111827', marginBottom: 3 }}>
            {alert.type || 'Strategic Alert'}
          </div>

          {/* Entity + message */}
          <div style={{ fontSize: 12, color: '#374151' }}>
            <strong>{alert.name}</strong> — {alert.message}
          </div>
        </div>

        {/* Acknowledge button */}
        {!isAcknowledged && (
          <button onClick={() => onAck(alert.id)} style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px',
            border: `1px solid ${sevCfg.dot}`, borderRadius: 8,
            background: '#fff', color: sevCfg.color, fontSize: 11, fontWeight: 700, cursor: 'pointer',
            flexShrink: 0,
          }}>
            <CheckCircle size={12} />
            Acknowledge
          </button>
        )}
        {isAcknowledged && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: C.green, fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
            <CheckCircle size={14} />
            Acknowledged
          </div>
        )}
      </div>
    </div>
  );
}

export default function StrategicAlertsPanel({ data, onRefresh }) {
  const [acknowledged, setAcknowledged] = useState(new Set());
  const [filter, setFilter] = useState('all'); // all | red | amber | unacked

  const alerts = data?.alerts || [];
  const counts = data?.counts || {};

  const ack = (id) => setAcknowledged(prev => new Set([...prev, id]));
  const ackAll = () => setAcknowledged(new Set(alerts.map(a => a.id)));

  const filtered = alerts.filter(a => {
    if (filter === 'red')    return a.severity === 'red';
    if (filter === 'amber')  return a.severity === 'amber';
    if (filter === 'unacked') return !acknowledged.has(a.id);
    return true;
  });

  const unackedCount = alerts.filter(a => !acknowledged.has(a.id)).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 900, color: '#111827' }}>CEO War Room</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>
            Strategic alerts requiring CEO/MD acknowledgement — Real-time
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {unackedCount > 0 && (
            <button onClick={ackAll} style={{
              padding: '7px 14px', border: `1px solid ${C.green}`, borderRadius: 8,
              background: '#dcfce7', color: C.green, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <CheckCircle size={13} />
              Acknowledge All
            </button>
          )}
          {onRefresh && (
            <button onClick={onRefresh} style={{
              padding: '7px 14px', border: `1px solid ${C.border}`, borderRadius: 8,
              background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <RefreshCw size={12} />
              Refresh
            </button>
          )}
        </div>
      </div>

      {/* Summary chips */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ padding: '6px 14px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, fontSize: 12, fontWeight: 700, color: C.red }}>
          {counts.red || 0} Red Alert{counts.red !== 1 ? 's' : ''}
        </div>
        <div style={{ padding: '6px 14px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 12, fontWeight: 700, color: '#92400e' }}>
          {counts.amber || 0} Warning{counts.amber !== 1 ? 's' : ''}
        </div>
        <div style={{ padding: '6px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12, fontWeight: 700, color: C.green }}>
          {alerts.length - unackedCount} Acknowledged
        </div>
        {unackedCount > 0 && (
          <div style={{ padding: '6px 14px', background: '#f5f3ff', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontWeight: 700, color: C.primary }}>
            {unackedCount} Pending
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 6 }}>
        {[['all','All Alerts'], ['red','Red Alerts'], ['amber','Warnings'], ['unacked','Unacknowledged']].map(([id, lbl]) => (
          <button key={id} onClick={() => setFilter(id)} style={{
            padding: '5px 12px', borderRadius: 7, border: `1px solid ${filter === id ? C.primary : C.border}`,
            background: filter === id ? C.primary : '#fff', color: filter === id ? '#fff' : '#6b7280',
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}>{lbl}</button>
        ))}
      </div>

      {/* Alert cards */}
      {filtered.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Red alerts first */}
          {filtered.filter(a => a.severity === 'red').map(a => (
            <AlertCard key={a.id} alert={a} onAck={ack} isAcknowledged={acknowledged.has(a.id)} />
          ))}
          {/* Then amber */}
          {filtered.filter(a => a.severity === 'amber').map(a => (
            <AlertCard key={a.id} alert={a} onAck={ack} isAcknowledged={acknowledged.has(a.id)} />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: 48, textAlign: 'center' }}>
          <CheckCircle size={36} color={C.green} style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 18, fontWeight: 700, color: C.green }}>All Clear</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>No strategic alerts at this time. Business is running smoothly.</div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 13 }}>
          No alerts match the current filter.
        </div>
      )}

      {/* CEO Critical Actions Guide */}
      {unackedCount > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12 }}>CEO Action Required</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
            {[
              { icon: Users,      color: C.blue,   text: 'Schedule customer review for all Critical customer alerts within 48 hours' },
              { icon: Package,    color: C.amber,  text: 'Initiate alternate vendor qualification for blocked/critical suppliers' },
              { icon: IndianRupee, color: C.red,    text: 'Escalate 90+ day collections to legal/MD level immediately' },
              { icon: FileText,   color: '#0891b2',text: 'AMC renewal calls to be initiated by account managers this week' },
            ].map(({ icon: Icon, color, text }, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 12px', background: `${color}08`, borderRadius: 10, border: `1px solid ${color}20` }}>
                <Icon size={14} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>{text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
