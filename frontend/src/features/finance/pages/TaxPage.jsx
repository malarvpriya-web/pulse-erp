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

  /* Deliberately NO <PageHero> here.
   *
   * TaxPage is a tab container: every one of the four children it renders
   * (GSTModule, TDSManagement, TCSManagement, ComplianceSettings) already
   * carries its own hero. Adding one at this level would stack two gradient
   * bands on top of each other. The tab strip is the only chrome this page
   * owns, so it is all this page styles. */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--color-bg-page, #f8f9fc)' }}>
      <div style={{ padding: '12px 20px 0', flexShrink: 0 }}>
        <div className="tax-tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`tax-tab${tab === t.id ? ' is-on' : ''}`}
            >{t.label}</button>
          ))}
        </div>
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
