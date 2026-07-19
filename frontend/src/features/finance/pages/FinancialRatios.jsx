import { useState, useEffect } from 'react';
import {
  CheckCircle, AlertTriangle,
  XCircle, RefreshCw, ChevronDown, ChevronRight, MinusCircle
} from 'lucide-react';
import api from '@/services/api/client';
import { useFY } from '@/context/FYContext';
import './FinancialRatios.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const getRatingColor = (rating) => {
  if (rating === 'good')     return { bg:'#dcfce7', color:'#16a34a', border:'#86efac' };
  if (rating === 'warning')  return { bg:'#fef3c7', color:'#d97706', border:'#fcd34d' };
  if (rating === 'critical') return { bg:'#fee2e2', color:'#dc2626', border:'#fca5a5' };
  return                            { bg:'#f3f4f6', color:'#9ca3af', border:'#e5e7eb' }; // neutral
};

const RatingIcon = ({ rating }) => {
  if (rating==='good')     return <CheckCircle   size={14} color="#16a34a"/>;
  if (rating==='warning')  return <AlertTriangle  size={14} color="#d97706"/>;
  if (rating==='critical') return <XCircle        size={14} color="#dc2626"/>;
  return                          <MinusCircle    size={14} color="#9ca3af"/>;
};

const fmtINR = (v) => {
  const n = parseFloat(v) || 0;
  if (n >= 10000000) return `₹${(n/10000000).toFixed(2)} Cr`;
  if (n >= 100000)   return `₹${(n/100000).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
};

// ── Static metadata: formulas, scale max, direction ──────────────────────────
const RATIO_META = {
  'Current Ratio':  { formula: 'Current Assets ÷ Current Liabilities',       max: 5,   higherIsBetter: true  },
  'Quick Ratio':    { formula: '(Cash + AR) ÷ Current Liabilities',           max: 4,   higherIsBetter: true  },
  'Cash Ratio':     { formula: 'Cash & Bank ÷ Current Liabilities',           max: 2,   higherIsBetter: true  },
  'Gross Margin':   { formula: '(Revenue − COGS) ÷ Revenue × 100',            max: 60,  higherIsBetter: true  },
  'Net Margin':     { formula: 'Net Profit ÷ Revenue × 100',                  max: 40,  higherIsBetter: true  },
  'ROA':            { formula: 'Net Profit ÷ Total Assets × 100',             max: 25,  higherIsBetter: true  },
  'ROE':            { formula: 'Net Profit ÷ Equity × 100',                   max: 40,  higherIsBetter: true  },
  'AR Turnover':    { formula: 'Revenue ÷ Accounts Receivable',               max: 15,  higherIsBetter: true  },
  'Asset Turnover': { formula: 'Revenue ÷ Total Assets',                      max: 3,   higherIsBetter: true  },
  'Debt/Equity':    { formula: 'Total Debt ÷ Equity',                         max: 4,   higherIsBetter: false },
  'Equity Ratio':   { formula: 'Equity ÷ Total Assets × 100',                 max: 100, higherIsBetter: true  },
};

const SECTION_META = {
  liquidity:     { label: 'Liquidity Ratios',     desc: 'Ability to meet short-term obligations',                     color: '#3b82f6' },
  profitability: { label: 'Profitability Ratios', desc: 'Ability to generate profit relative to revenue and assets', color: '#10b981' },
  efficiency:    { label: 'Efficiency Ratios',    desc: 'How effectively assets and liabilities are managed',        color: '#f59e0b' },
  leverage:      { label: 'Solvency Ratios',      desc: 'Ability to meet long-term financial obligations',           color: '#8b5cf6' },
};

function deriveRating(value, benchmark, higherIsBetter) {
  if (value === null || value === undefined || benchmark === null) return 'neutral';
  const v = parseFloat(value);
  const b = parseFloat(benchmark);
  if (isNaN(v) || isNaN(b)) return 'neutral';
  if (higherIsBetter) {
    if (v >= b)        return 'good';
    if (v >= b * 0.70) return 'warning';
    return 'critical';
  } else {
    if (v <= b)        return 'good';
    if (v <= b * 1.30) return 'warning';
    return 'critical';
  }
}

function buildSections(apiRatios) {
  return Object.entries(apiRatios).map(([key, items]) => {
    const sm = SECTION_META[key] || { label: key, desc: '', color: '#6b7280' };
    const ratios = items.map(item => {
      const m = RATIO_META[item.name] || {
        formula: item.description || '—',
        max: Math.max(parseFloat(item.benchmark || 1) * 3, 1),
        higherIsBetter: true,
      };
      const rating = deriveRating(item.value, item.benchmark, m.higherIsBetter);
      return {
        id:             item.name,
        name:           item.name,
        value:          item.value !== null && item.value !== undefined ? String(item.value) : null,
        unit:           item.unit || '',
        benchmark:      item.benchmark,
        max:            m.max,
        rating,
        trend:          [],
        formula:        m.formula,
        description:    item.description || '',
        higherIsBetter: m.higherIsBetter,
        components:     item.components || null,
      };
    });
    return [key, { ...sm, ratios }];
  });
}

// ── Gauge component ───────────────────────────────────────────────────────────
const Gauge = ({ value, max, rating, size=80 }) => {
  const pct     = Math.min((value / Math.max(max, 1)) * 100, 100);
  const r       = (size/2) - 8;
  const cx      = size / 2;
  const cy      = size / 2;
  const circ    = Math.PI * r;
  const dash    = (pct / 100) * circ;
  const colors  = { good:'#10b981', warning:'#f59e0b', critical:'#ef4444', neutral:'#9ca3af' };
  const color   = colors[rating] || '#6366f1';

  return (
    <svg width={size} height={size/2 + 10} viewBox={`0 0 ${size} ${size/2 + 10}`}>
      <path
        d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`}
        fill="none" stroke="#f3f4f6" strokeWidth="8" strokeLinecap="round"/>
      <path
        d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`}
        fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}/>
      <text x={cx} y={cy-2} textAnchor="middle"
        fontSize="13" fontWeight="700" fill="#111827">{pct.toFixed(0)}%</text>
    </svg>
  );
};

// ── Ratio Card ────────────────────────────────────────────────────────────────
const RatioCard = ({ ratio }) => {
  const [expanded, setExpanded] = useState(false);
  const rc = getRatingColor(ratio.rating);
  const isNA = ratio.value === null;
  const numVal = isNA ? null : (parseFloat(ratio.value) || 0);
  const hasTrend = ratio.trend && ratio.trend.length > 1;

  const ratingLabel = isNA ? 'N/A'
    : ratio.rating.charAt(0).toUpperCase() + ratio.rating.slice(1);

  return (
    <div className="fr-card" style={{borderTopColor: rc.color}}>
      <div className="fr-card-hd">
        <div className="fr-card-left">
          <span className="fr-card-name">{ratio.name}</span>
          <div className="fr-card-badges">
            <span className="fr-rating-badge"
              style={{background:rc.bg, color:rc.color, borderColor:rc.border}}>
              <RatingIcon rating={ratio.rating}/>
              {ratingLabel}
            </span>
          </div>
        </div>
        <div className="fr-card-right">
          <span className="fr-card-val" style={{color: isNA ? '#9ca3af' : rc.color}}>
            {isNA ? 'N/A' : `${ratio.value}${ratio.unit}`}
          </span>
          <span className="fr-card-bench">Bench: {ratio.benchmark}{ratio.unit}</span>
        </div>
      </div>

      {!isNA && numVal !== null ? (
        <Gauge value={numVal} max={ratio.max} rating={ratio.rating}/>
      ) : (
        <div style={{textAlign:'center', padding:'6px 0 4px', fontSize:11, color:'#9ca3af'}}>
          No data — post transactions to calculate
        </div>
      )}

      {hasTrend && (
        <>
          <div className="fr-card-trend">
            {ratio.trend.map((v,i) => (
              <div key={i} className="fr-trend-bar-wrap">
                <div className="fr-trend-bar"
                  style={{
                    height:`${Math.max((v/Math.max(...ratio.trend))*40,4)}px`,
                    background: i===ratio.trend.length-1 ? rc.color : '#e5e7eb'
                  }}/>
              </div>
            ))}
          </div>
          <div className="fr-card-trend-label">6-month trend</div>
        </>
      )}

      <button className="fr-expand-btn" onClick={()=>setExpanded(e=>!e)}>
        {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
        {expanded ? 'Less' : 'Details'}
      </button>

      {expanded && (
        <div className="fr-card-detail">
          {ratio.description && <p className="fr-detail-desc">{ratio.description}</p>}
          <div className="fr-detail-formula">
            <span className="fr-formula-label">Formula:</span>
            <span className="fr-formula">{ratio.formula}</span>
          </div>
          {ratio.components && Object.entries(ratio.components).map(([k, v]) => (
            <div key={k} className="fr-detail-row">
              <span>{k}</span>
              <strong>{typeof v === 'number' ? fmtINR(v) : v}</strong>
            </div>
          ))}
          <div className="fr-detail-row" style={{borderTop:'1px solid #f0f0f4', paddingTop:6, marginTop:2}}>
            <span>Industry Benchmark</span>
            <strong style={{color: rc.color}}>{ratio.benchmark}{ratio.unit}</strong>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
export default function FinancialRatios() {
  const { fyParams, fyLabel } = useFY();
  const [apiData,   setApiData]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [activeSection, setActiveSection] = useState('all');
  const [expanded, setExpanded]   = useState({ liquidity:true, profitability:true, leverage:true, efficiency:true });

  const fetchRatios = () => {
    setLoading(true);
    const params = `?fy=${fyParams.fy}&fyStart=${fyParams.fyStart}&fyEnd=${fyParams.fyEnd}`;
    api.get(`/statements/ratios${params}`)
      .then(r => setApiData(r.data))
      .catch(() => {
        // Graceful degradation: show N/A ratios instead of a blank error page.
        // The backend may fail if no transactions exist yet for the selected FY.
        setApiData({
          ratios: {
            liquidity:     [
              { name: 'Current Ratio', value: null, benchmark: 2.0, unit: 'x', description: 'Measures short-term obligation coverage.' },
              { name: 'Quick Ratio',   value: null, benchmark: 1.0, unit: 'x', description: 'Liquidity excluding inventory.' },
              { name: 'Cash Ratio',    value: null, benchmark: 0.5, unit: 'x', description: 'Strictest liquidity — cash only vs. liabilities.' },
            ],
            profitability: [
              { name: 'Gross Margin', value: null, benchmark: 40,  unit: '%', description: 'Profit after cost of goods sold.' },
              { name: 'Net Margin',   value: null, benchmark: 10,  unit: '%', description: 'Bottom-line profit percentage.' },
              { name: 'ROA',          value: null, benchmark: 5,   unit: '%', description: 'Return generated on total assets.' },
              { name: 'ROE',          value: null, benchmark: 15,  unit: '%', description: "Return generated on shareholders' equity." },
            ],
            efficiency: [
              { name: 'AR Turnover',    value: null, benchmark: 8, unit: 'x', description: 'How fast receivables are collected.' },
              { name: 'Asset Turnover', value: null, benchmark: 1, unit: 'x', description: 'Revenue generated per rupee of assets.' },
            ],
            leverage: [
              { name: 'Debt/Equity',  value: null, benchmark: 2.0, unit: 'x',  description: 'Financial leverage — debt vs. shareholder equity.' },
              { name: 'Equity Ratio', value: null, benchmark: 50,  unit: '%', description: 'Proportion of assets financed by equity.' },
            ],
          },
          _noData: true,
        });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchRatios(); }, [fyParams.fy]);

  const toggleSection = (key) => setExpanded(p=>({...p,[key]:!p[key]}));

  const sections = apiData ? buildSections(apiData.ratios) : [];
  const allRatios   = sections.flatMap(([, s]) => s.ratios);
  const goodCount   = allRatios.filter(r => r.rating === 'good').length;
  const warnCount   = allRatios.filter(r => r.rating === 'warning').length;
  const badCount    = allRatios.filter(r => r.rating === 'critical').length;

  // Weighted health score: Good=100%, Warning=50%, Critical=0%
  const ratedCount    = allRatios.filter(r => r.rating !== 'neutral').length;
  const weightedScore = ratedCount > 0
    ? Math.round((goodCount * 100 + warnCount * 50) / (ratedCount * 100) * 100)
    : 0;

  const visibleSections = activeSection === 'all'
    ? sections
    : sections.filter(([k]) => k === activeSection);

  const sectionKeys = sections.map(([k]) => k);

  // Chart shows ratios for the active category (or first 6 when All)
  const chartRatios = activeSection === 'all'
    ? allRatios.slice(0, 6)
    : (sections.find(([k]) => k === activeSection)?.[1]?.ratios || []);

  if (loading) {
    return (
      <div className="fr-root">
        <div style={{ textAlign:'center', padding:'80px 24px', color:'#9ca3af' }}>
          <div style={{ fontSize:15, fontWeight:600 }}>Loading financial ratios…</div>
        </div>
      </div>
    );
  }

  if (!apiData) {
    return (
      <div className="fr-root">
        <div style={{ textAlign:'center', padding:'80px 24px', color:'#9ca3af' }}>
          <XCircle size={40} color="#d1d5db" style={{ margin:'0 auto 12px' }} />
          <div style={{ fontSize:15, fontWeight:600, color:'#6b7280' }}>No ratio data available</div>
          <div style={{ fontSize:13, marginTop:4 }}>
            Ensure balance sheet and income data are posted for {fyLabel}.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fr-root">

      {/* No-data banner */}
      {apiData._noData && (
        <div style={{
          background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8,
          padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 13, color: '#92400e',
        }}>
          <AlertTriangle size={15} color="#d97706" style={{ flexShrink: 0 }} />
          Ratios show N/A — post balance sheet and income transactions for {fyLabel} to calculate live values.
        </div>
      )}

      {/* Header */}
      <div className="fr-header">
        <div>
          <h2 className="fr-title">Financial Ratios</h2>
          <p className="fr-sub">
            {allRatios.length} ratios across {sections.length} categories ·
            {fyLabel}
          </p>
        </div>
        <div className="fr-header-r">
          <button className="fr-btn-outline" onClick={fetchRatios}>
            <RefreshCw size={14}/> Recalculate
          </button>
        </div>
      </div>

      {/* Health summary */}
      <div className="fr-health">
        <div className="fr-health-score">
          <div className="fr-score-circle">
            <svg viewBox="0 0 100 100" width="90" height="90">
              <circle cx="50" cy="50" r="40" fill="none" stroke="#f3f4f6" strokeWidth="10"/>
              <circle cx="50" cy="50" r="40" fill="none" stroke="#10b981" strokeWidth="10"
                strokeDasharray={`${(weightedScore / 100) * 251} 251`}
                strokeLinecap="round" transform="rotate(-90 50 50)"/>
              <text x="50" y="46" textAnchor="middle" fontSize="18" fontWeight="700" fill="#111827">
                {weightedScore}%
              </text>
              <text x="50" y="60" textAnchor="middle" fontSize="9" fill="#9ca3af">health</text>
            </svg>
          </div>
          <div>
            <h3 className="fr-health-title">Overall Financial Health</h3>
            <p className="fr-health-sub">Weighted score across {ratedCount} rated ratios</p>
            <div className="fr-health-chips">
              <span className="fr-chip fr-chip-good">
                <CheckCircle size={11}/> {goodCount} Good
              </span>
              <span className="fr-chip fr-chip-warn">
                <AlertTriangle size={11}/> {warnCount} Warning
              </span>
              <span className="fr-chip fr-chip-bad">
                <XCircle size={11}/> {badCount} Critical
              </span>
            </div>
          </div>
        </div>

        {/* Ratio vs benchmark comparison bars */}
        <div className="fr-health-chart" style={{ flex: 1 }}>
          <p className="fr-chart-title">
            Value vs Benchmark — {activeSection === 'all' ? fyLabel : SECTION_META[activeSection]?.label || activeSection}
          </p>
          <div style={{ display:'flex', flexDirection:'column', gap:8, padding:'8px 0' }}>
            {chartRatios.map(r => {
              const val   = parseFloat(r.value) || 0;
              const bench = parseFloat(r.benchmark) || 1;
              const max   = Math.max(r.max, val * 1.2, bench * 1.5);
              const rc    = getRatingColor(r.rating);
              return (
                <div key={r.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:11 }}>
                  <div style={{ width:110, color:'#6b7280', textAlign:'right', flexShrink:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</div>
                  <div style={{ flex:1, background:'#f3f4f6', borderRadius:4, height:10, position:'relative' }}>
                    <div style={{ width:`${Math.min((val/max)*100, 100)}%`, background:rc.color, height:'100%', borderRadius:4, transition:'width 0.4s' }}/>
                    <div style={{ position:'absolute', top:0, left:`${Math.min((bench/max)*100, 100)}%`, width:2, height:'100%', background:'#374151', borderRadius:2 }}/>
                  </div>
                  <div style={{ width:44, fontWeight:600, color: r.value === null ? '#9ca3af' : rc.color }}>
                    {r.value === null ? 'N/A' : `${r.value}${r.unit}`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="fr-filter-tabs">
        <button
          className={`fr-filter-tab${activeSection==='all'?' active':''}`}
          onClick={()=>setActiveSection('all')}>
          All Ratios
          <span className="fr-tab-count">{allRatios.length}</span>
        </button>
        {sectionKeys.map(k => {
          const sm = SECTION_META[k] || { label: k };
          const count = sections.find(([sk])=>sk===k)?.[1]?.ratios?.length || 0;
          return (
            <button key={k}
              className={`fr-filter-tab${activeSection===k?' active':''}`}
              onClick={()=>setActiveSection(k)}>
              {sm.label.replace(' Ratios','')}
              <span className="fr-tab-count">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Ratio sections */}
      {visibleSections.map(([key, section]) => (
        <div key={key} className="fr-section">
          <div className="fr-section-hd" onClick={()=>toggleSection(key)}
            style={{borderLeftColor:section.color}}>
            <div className="fr-section-left">
              {expanded[key] ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}
              <span className="fr-section-title" style={{color:section.color}}>
                {section.label}
              </span>
              <span className="fr-section-desc">{section.desc}</span>
            </div>
            <div className="fr-section-summary">
              <span className="fr-chip fr-chip-good">
                {section.ratios.filter(r=>r.rating==='good').length} good
              </span>
              <span className="fr-chip fr-chip-warn">
                {section.ratios.filter(r=>r.rating==='warning').length} warn
              </span>
              <span className="fr-chip fr-chip-bad">
                {section.ratios.filter(r=>r.rating==='critical').length} critical
              </span>
            </div>
          </div>

          {expanded[key] && (
            <div className="fr-cards-grid">
              {section.ratios.map(ratio => (
                <RatioCard key={ratio.id} ratio={ratio}/>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Benchmark legend */}
      <div className="fr-legend">
        <span className="fr-legend-title">Rating Guide:</span>
        <span className="fr-chip fr-chip-good"><CheckCircle size={11}/> Good — meets or exceeds benchmark</span>
        <span className="fr-chip fr-chip-warn"><AlertTriangle size={11}/> Warning — within 30% of threshold</span>
        <span className="fr-chip fr-chip-bad"><XCircle size={11}/> Critical — below safe level</span>
      </div>
    </div>
  );
}
