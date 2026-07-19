// frontend/src/features/analytics/pages/AIInsightsPanel.jsx
// Phase 49H — AI Insights (Section 15) — Auto-generated CEO intelligence
// Embedded in StrategicAlertsPanel/War Room tab; also importable standalone
import { useState, useEffect, useCallback, useRef } from 'react';
import { Zap, RefreshCw, ChevronDown, ChevronRight, TrendingUp, AlertTriangle, IndianRupee, Package, BarChart2 } from 'lucide-react';
import api from '@/services/api/client';

const C = {
  primary: '#6B3FDB', green: '#16a34a', red: '#dc2626',
  amber: '#d97706', blue: '#2563eb', border: '#e9e4ff', cyan: '#0891b2',
};

const INSIGHT_SECTIONS = [
  {
    key: 'customer_risks',
    title: 'Top 5 Customer Risks',
    icon: AlertTriangle,
    color: C.red,
    bg: '#fff1f2',
  },
  {
    key: 'supplier_risks',
    title: 'Top 5 Supplier Risks',
    icon: Package,
    color: C.amber,
    bg: '#fffbeb',
  },
  {
    key: 'growth_opportunities',
    title: 'Top 5 Growth Opportunities',
    icon: TrendingUp,
    color: C.green,
    bg: '#f0fdf4',
  },
  {
    key: 'collection_risks',
    title: 'Top 5 Collection Risks',
    icon: IndianRupee,
    color: '#db2777',
    bg: '#fdf2f8',
  },
  {
    key: 'margin_risks',
    title: 'Top 5 Margin Risks',
    icon: BarChart2,
    color: C.blue,
    bg: '#eff6ff',
  },
];

function InsightSection({ section, insights }) {
  const [expanded, setExpanded] = useState(true);
  const Icon = section.icon;
  const items = insights[section.key] || [];

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', background: section.bg, border: 'none', cursor: 'pointer',
          borderBottom: expanded ? `1px solid ${C.border}` : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `${section.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon size={16} color={section.color} />
          </div>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{section.title}</span>
          <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500 }}>{items.length} insights</span>
        </div>
        {expanded ? <ChevronDown size={16} color="#9ca3af" /> : <ChevronRight size={16} color="#9ca3af" />}
      </button>

      {expanded && (
        <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((insight, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 12px', background: i % 2 === 0 ? '#fafafa' : '#fff', borderRadius: 8, border: '1px solid #f3f4f6' }}>
              <div style={{
                width: 22, height: 22, borderRadius: '50%', background: `${section.color}15`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 800, color: section.color, flexShrink: 0,
              }}>
                {i + 1}
              </div>
              <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6 }}>{insight}</div>
            </div>
          ))}
          {items.length === 0 && (
            <div style={{ padding: '12px 0', color: '#9ca3af', fontSize: 12, textAlign: 'center' }}>No insights available</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AIInsightsPanel() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/ceo-intelligence/ai-insights');
      if (ctrl.signal.aborted) return;
      setData(res.data);
    } catch (e) {
      if (!ctrl.signal.aborted) setError('Failed to load AI insights');
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 16 }}>
        <div style={{ width: 40, height: 40, borderRadius: '50%', border: `3px solid ${C.border}`, borderTopColor: C.primary, animation: 'spin 0.8s linear infinite' }} />
        <div style={{ fontSize: 13, color: '#6b7280' }}>Generating AI insights from live data…</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: '#fff5f5', border: '1px solid #fca5a5', borderRadius: 14, padding: 32, textAlign: 'center' }}>
        <AlertTriangle size={28} color={C.red} style={{ marginBottom: 10 }} />
        <div style={{ fontSize: 14, color: C.red, fontWeight: 600 }}>{error}</div>
        <button onClick={load} style={{ marginTop: 14, padding: '7px 16px', background: C.red, border: 'none', borderRadius: 8, color: '#fff', fontSize: 12, cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    );
  }

  const insights = data?.insights || {};
  const summary  = data?.summary  || '';
  const genAt    = data?.generated_at ? new Date(data.generated_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: `${C.primary}20`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Zap size={18} color={C.primary} />
            </div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#111827' }}>AI Insights</div>
            <span style={{ padding: '3px 10px', background: `${C.primary}15`, borderRadius: 12, fontSize: 11, fontWeight: 700, color: C.primary }}>
              AI-Generated · Live Data
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#9ca3af', paddingLeft: 46 }}>
            Automatically generated from your live ERP data
            {genAt && ` · ${genAt}`}
          </div>
        </div>
        <button onClick={load} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px',
          border: `1px solid ${C.border}`, borderRadius: 8, background: '#fff',
          color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>
          <RefreshCw size={13} />
          Regenerate
        </button>
      </div>

      {/* Executive Summary */}
      {summary && (
        <div style={{
          background: `linear-gradient(135deg, ${C.primary}10, ${C.blue}08)`,
          border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 22px',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.primary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Executive Summary
          </div>
          <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.7, fontStyle: 'italic' }}>
            "{summary}"
          </div>
        </div>
      )}

      {/* Insight Sections */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {INSIGHT_SECTIONS.map(section => (
          <InsightSection key={section.key} section={section} insights={insights} />
        ))}
      </div>

      {/* Disclaimer */}
      <div style={{ padding: '10px 14px', background: '#f9fafb', borderRadius: 10, border: '1px solid #f3f4f6' }}>
        <div style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.6 }}>
          <strong style={{ color: '#6b7280' }}>Note:</strong> AI insights are generated from live ERP data using rule-based analysis.
          They reflect patterns observed in actual business data — no hardcoded or fabricated values.
          Insights should be reviewed by relevant business stakeholders before action is taken.
        </div>
      </div>
    </div>
  );
}
