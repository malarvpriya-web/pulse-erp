import { useState } from 'react';
import GSTModule         from './GSTModule';
import TDSManagement     from './TDSManagement';
import TCSManagement     from './TCSManagement';
import ComplianceSettings from './ComplianceSettings';

const TABS = [
  { id: 'gst',        label: 'GST & Tax' },
  { id: 'tds',        label: 'TDS Management' },
  { id: 'tcs',        label: 'TCS Management' },
  { id: 'compliance', label: 'Compliance Settings' },
];

export default function TaxPage() {
  const [tab, setTab] = useState('gst');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#f8f9fc' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '0 24px', display: 'flex', gap: 0, flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '14px 20px',
            border: 'none',
            borderBottom: tab === t.id ? '2px solid #6366f1' : '2px solid transparent',
            background: 'transparent',
            color: tab === t.id ? '#6366f1' : '#6b7280',
            fontSize: 13,
            fontWeight: tab === t.id ? 600 : 400,
            cursor: 'pointer',
            transition: 'all .15s',
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ flex: 1 }}>
        {tab === 'gst'        && <GSTModule/>}
        {tab === 'tds'        && <TDSManagement/>}
        {tab === 'tcs'        && <TCSManagement/>}
        {tab === 'compliance' && <ComplianceSettings/>}
      </div>
    </div>
  );
}
