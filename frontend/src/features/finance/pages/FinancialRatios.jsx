import { useState, useCallback } from 'react';
import {
  RadialBarChart, RadialBar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import {
  TrendingUp, TrendingDown, CheckCircle, AlertTriangle,
  XCircle, RefreshCw, Download, Info, ChevronDown, ChevronRight
} from 'lucide-react';
import './FinancialRatios.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const getRatingColor = (rating) => {
  if (rating === 'good')    return { bg:'#dcfce7', color:'#16a34a', border:'#86efac' };
  if (rating === 'warning') return { bg:'#fef3c7', color:'#d97706', border:'#fcd34d' };
  return                           { bg:'#fee2e2', color:'#dc2626', border:'#fca5a5' };
};

const getRating = (value, good, warning, higherIsBetter=true) => {
  if (higherIsBetter) {
    if (value >= good)    return 'good';
    if (value >= warning) return 'warning';
    return 'danger';
  } else {
    if (value <= good)    return 'good';
    if (value <= warning) return 'warning';
    return 'danger';
  }
};

const RatingIcon = ({ rating }) => {
  if (rating==='good')    return <CheckCircle  size={14} color="#16a34a"/>;
  if (rating==='warning') return <AlertTriangle size={14} color="#d97706"/>;
  return                         <XCircle       size={14} color="#dc2626"/>;
};

// ── Gauge component ───────────────────────────────────────────────────────────
const Gauge = ({ value, max, rating, size=80 }) => {
  const pct     = Math.min((value / max) * 100, 100);
  const r       = (size/2) - 8;
  const cx      = size / 2;
  const cy      = size / 2;
  const circ    = Math.PI * r;
  const dash    = (pct / 100) * circ;
  const colors  = { good:'#10b981', warning:'#f59e0b', danger:'#ef4444' };
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

  return (
    <div className="fr-card" style={{borderTopColor: rc.color}}>
      <div className="fr-card-hd">
        <div className="fr-card-left">
          <span className="fr-card-name">{ratio.name}</span>
          <div className="fr-card-badges">
            <span className="fr-rating-badge"
              style={{background:rc.bg, color:rc.color, borderColor:rc.border}}>
              <RatingIcon rating={ratio.rating}/>
              {ratio.rating.charAt(0).toUpperCase()+ratio.rating.slice(1)}
            </span>
          </div>
        </div>
        <div className="fr-card-right">
          <span className="fr-card-val" style={{color:rc.color}}>
            {ratio.value}{ratio.unit||''}
          </span>
          <span className="fr-card-bench">Bench: {ratio.benchmark}{ratio.unit||''}</span>
        </div>
      </div>

      <Gauge
        value={Math.min(parseFloat(ratio.value), parseFloat(ratio.max||ratio.value*1.5))}
        max={parseFloat(ratio.max||ratio.value*1.5)}
        rating={ratio.rating}/>

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

      <button className="fr-expand-btn" onClick={()=>setExpanded(e=>!e)}>
        {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
        {expanded ? 'Less' : 'Details'}
      </button>

      {expanded && (
        <div className="fr-card-detail">
          <p className="fr-detail-desc">{ratio.description}</p>
          <div className="fr-detail-formula">
            <span className="fr-formula-label">Formula:</span>
            <span className="fr-formula">{ratio.formula}</span>
          </div>
          <div className="fr-detail-row">
            <span>Industry Benchmark</span><strong>{ratio.benchmark}{ratio.unit||''}</strong>
          </div>
          <div className="fr-detail-row">
            <span>Previous Period</span>
            <strong>{ratio.trend[ratio.trend.length-2]}{ratio.unit||''}</strong>
          </div>
          <div className="fr-detail-row">
            <span>Change</span>
            <strong className={
              parseFloat(ratio.value) > ratio.trend[ratio.trend.length-2]
                ? (ratio.higherIsBetter !== false ? 'fr-pos' : 'fr-neg')
                : (ratio.higherIsBetter !== false ? 'fr-neg' : 'fr-pos')
            }>
              {parseFloat(ratio.value) > ratio.trend[ratio.trend.length-2] ? '▲' : '▼'}
              {' '}{Math.abs(parseFloat(ratio.value) - ratio.trend[ratio.trend.length-2]).toFixed(2)}{ratio.unit||''}
            </strong>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Data ──────────────────────────────────────────────────────────────────────
const RATIO_DATA = {
  liquidity: {
    label: 'Liquidity Ratios',
    desc: 'Ability to meet short-term obligations',
    color: '#3b82f6',
    ratios: [
      {
        id:'current', name:'Current Ratio', value:'2.4', unit:'x',
        benchmark:'2.0', max:5, rating: getRating(2.4,2,1.5),
        trend:[1.8,2.0,2.1,2.2,2.3,2.4],
        formula:'Current Assets ÷ Current Liabilities',
        description:'Measures ability to pay short-term liabilities with short-term assets. Above 2x is healthy.',
        higherIsBetter:true,
      },
      {
        id:'quick', name:'Quick Ratio', value:'1.8', unit:'x',
        benchmark:'1.0', max:4, rating: getRating(1.8,1,0.75),
        trend:[1.4,1.5,1.6,1.6,1.7,1.8],
        formula:'(Current Assets - Inventory) ÷ Current Liabilities',
        description:'Measures ability to meet short-term obligations without relying on inventory sales.',
        higherIsBetter:true,
      },
      {
        id:'cash', name:'Cash Ratio', value:'0.8', unit:'x',
        benchmark:'0.5', max:2, rating: getRating(0.8,0.5,0.3),
        trend:[0.5,0.6,0.6,0.7,0.7,0.8],
        formula:'Cash & Cash Equivalents ÷ Current Liabilities',
        description:'Most conservative liquidity measure — only cash against current liabilities.',
        higherIsBetter:true,
      },
      {
        id:'operating', name:'Operating Cash Flow Ratio', value:'1.3', unit:'x',
        benchmark:'1.0', max:3, rating: getRating(1.3,1,0.8),
        trend:[0.9,1.0,1.1,1.1,1.2,1.3],
        formula:'Operating Cash Flow ÷ Current Liabilities',
        description:'Indicates how well current liabilities are covered by cash generated from operations.',
        higherIsBetter:true,
      },
    ]
  },
  profitability: {
    label: 'Profitability Ratios',
    desc: 'Ability to generate profit relative to revenue and assets',
    color: '#10b981',
    ratios: [
      {
        id:'gross_margin', name:'Gross Profit Margin', value:'28.0', unit:'%',
        benchmark:'30.0', max:60, rating: getRating(28,30,20),
        trend:[22,24,25,26,27,28],
        formula:'(Revenue - COGS) ÷ Revenue × 100',
        description:'Percentage of revenue retained after direct costs. Higher indicates better production efficiency.',
        higherIsBetter:true,
      },
      {
        id:'net_margin', name:'Net Profit Margin', value:'15.3', unit:'%',
        benchmark:'15.0', max:40, rating: getRating(15.3,15,10),
        trend:[10,11,12,13,14,15.3],
        formula:'Net Profit ÷ Revenue × 100',
        description:'Overall profitability after all expenses, taxes, and interest.',
        higherIsBetter:true,
      },
      {
        id:'ebitda_margin', name:'EBITDA Margin', value:'31.2', unit:'%',
        benchmark:'20.0', max:60, rating: getRating(31.2,20,15),
        trend:[24,26,27,28,30,31.2],
        formula:'EBITDA ÷ Revenue × 100',
        description:'Operational profitability before financing and accounting decisions.',
        higherIsBetter:true,
      },
      {
        id:'roe', name:'Return on Equity (ROE)', value:'18.2', unit:'%',
        benchmark:'15.0', max:40, rating: getRating(18.2,15,10),
        trend:[12,13,15,16,17,18.2],
        formula:'Net Profit ÷ Shareholders Equity × 100',
        description:'How efficiently the company uses equity to generate profits.',
        higherIsBetter:true,
      },
      {
        id:'roa', name:'Return on Assets (ROA)', value:'9.4', unit:'%',
        benchmark:'8.0', max:25, rating: getRating(9.4,8,5),
        trend:[6,7,7.5,8,8.8,9.4],
        formula:'Net Profit ÷ Total Assets × 100',
        description:'How efficiently assets are used to generate earnings.',
        higherIsBetter:true,
      },
      {
        id:'roce', name:'Return on Capital Employed', value:'14.8', unit:'%',
        benchmark:'12.0', max:35, rating: getRating(14.8,12,8),
        trend:[9,10,11,12,13,14.8],
        formula:'EBIT ÷ (Total Assets - Current Liabilities) × 100',
        description:'Efficiency of capital use in generating profits.',
        higherIsBetter:true,
      },
    ]
  },
  solvency: {
    label: 'Solvency Ratios',
    desc: 'Ability to meet long-term financial obligations',
    color: '#8b5cf6',
    ratios: [
      {
        id:'debt_equity', name:'Debt-to-Equity', value:'0.42', unit:'',
        benchmark:'1.0', max:2, rating: getRating(0.42,1,1.5,false),
        trend:[0.8,0.75,0.65,0.6,0.5,0.42],
        formula:'Total Debt ÷ Shareholders Equity',
        description:'Financial leverage — lower means less reliance on debt financing.',
        higherIsBetter:false,
      },
      {
        id:'debt_assets', name:'Debt-to-Assets', value:'0.29', unit:'',
        benchmark:'0.5', max:1, rating: getRating(0.29,0.5,0.7,false),
        trend:[0.5,0.47,0.42,0.38,0.33,0.29],
        formula:'Total Debt ÷ Total Assets',
        description:'Proportion of assets financed by debt. Below 0.5 is generally healthy.',
        higherIsBetter:false,
      },
      {
        id:'interest_cov', name:'Interest Coverage', value:'8.4', unit:'x',
        benchmark:'3.0', max:15, rating: getRating(8.4,3,2),
        trend:[4,5,6,6.5,7.2,8.4],
        formula:'EBIT ÷ Interest Expense',
        description:'How many times interest expense is covered by earnings. Above 3x is safe.',
        higherIsBetter:true,
      },
      {
        id:'equity_ratio', name:'Equity Ratio', value:'58.3', unit:'%',
        benchmark:'50.0', max:100, rating: getRating(58.3,50,30),
        trend:[42,45,48,50,55,58.3],
        formula:'Shareholders Equity ÷ Total Assets × 100',
        description:'Proportion of assets financed by equity. Higher means more financial stability.',
        higherIsBetter:true,
      },
    ]
  },
  efficiency: {
    label: 'Efficiency Ratios',
    desc: 'How effectively assets and liabilities are managed',
    color: '#f59e0b',
    ratios: [
      {
        id:'asset_turn', name:'Asset Turnover', value:'1.2', unit:'x',
        benchmark:'1.0', max:3, rating: getRating(1.2,1,0.7),
        trend:[0.8,0.9,0.9,1.0,1.1,1.2],
        formula:'Revenue ÷ Total Assets',
        description:'How efficiently assets generate revenue. Higher is better.',
        higherIsBetter:true,
      },
      {
        id:'inv_turn', name:'Inventory Turnover', value:'4.2', unit:'x',
        benchmark:'4.0', max:10, rating: getRating(4.2,4,2.5),
        trend:[3.0,3.2,3.5,3.7,4.0,4.2],
        formula:'COGS ÷ Average Inventory',
        description:'How quickly inventory is sold. Higher means faster-moving stock.',
        higherIsBetter:true,
      },
      {
        id:'ar_days', name:'Debtor Days (DSO)', value:'38', unit:' days',
        benchmark:'45', max:90, rating: getRating(38,45,60,false),
        trend:[55,52,48,45,42,38],
        formula:'(Accounts Receivable ÷ Revenue) × 365',
        description:'Average days to collect payment. Lower means faster collection.',
        higherIsBetter:false,
      },
      {
        id:'ap_days', name:'Creditor Days (DPO)', value:'52', unit:' days',
        benchmark:'60', max:120, rating: getRating(52,60,90,false),
        trend:[45,46,48,50,51,52],
        formula:'(Accounts Payable ÷ COGS) × 365',
        description:'Average days to pay suppliers. Higher means better cash management.',
        higherIsBetter:true,
      },
      {
        id:'cash_cycle', name:'Cash Conversion Cycle', value:'24', unit:' days',
        benchmark:'30', max:90, rating: getRating(24,30,50,false),
        trend:[45,40,36,32,28,24],
        formula:'Inventory Days + Debtor Days - Creditor Days',
        description:'Days to convert investments into cash. Lower means better efficiency.',
        higherIsBetter:false,
      },
      {
        id:'wc_turn', name:'Working Capital Turnover', value:'3.8', unit:'x',
        benchmark:'3.0', max:8, rating: getRating(3.8,3,2),
        trend:[2.4,2.8,3.0,3.2,3.5,3.8],
        formula:'Revenue ÷ Working Capital',
        description:'How efficiently working capital generates revenue.',
        higherIsBetter:true,
      },
    ]
  },
};

const TREND_DATA = [
  {month:'Oct', currentRatio:1.8, grossMargin:22, netMargin:10, debtEquity:0.8},
  {month:'Nov', currentRatio:2.0, grossMargin:24, netMargin:11, debtEquity:0.75},
  {month:'Dec', currentRatio:2.1, grossMargin:25, netMargin:12, debtEquity:0.65},
  {month:'Jan', currentRatio:2.2, grossMargin:26, netMargin:13, debtEquity:0.60},
  {month:'Feb', currentRatio:2.3, grossMargin:27, netMargin:14, debtEquity:0.50},
  {month:'Mar', currentRatio:2.4, grossMargin:28, netMargin:15.3, debtEquity:0.42},
];

export default function FinancialRatios() {
  const [activeSection, setActiveSection] = useState('all');
  const [expanded,      setExpanded]      = useState({liquidity:true,profitability:true,solvency:true,efficiency:true});

  const toggleSection = (key) =>
    setExpanded(p=>({...p,[key]:!p[key]}));

  const allRatios = Object.values(RATIO_DATA).flatMap(s=>s.ratios);
  const goodCount = allRatios.filter(r=>r.rating==='good').length;
  const warnCount = allRatios.filter(r=>r.rating==='warning').length;
  const badCount  = allRatios.filter(r=>r.rating==='danger').length;

  const sections = activeSection==='all'
    ? Object.entries(RATIO_DATA)
    : Object.entries(RATIO_DATA).filter(([k])=>k===activeSection);

  return (
    <div className="fr-root">

      {/* Header */}
      <div className="fr-header">
        <div>
          <h2 className="fr-title">Financial Ratios</h2>
          <p className="fr-sub">
            {allRatios.length} ratios across 4 categories ·
            As of {new Date().toLocaleDateString('en-IN',{month:'long',year:'numeric'})}
          </p>
        </div>
        <div className="fr-header-r">
          <button className="fr-btn-outline"><Download size={14}/> Export Report</button>
          <button className="fr-btn-outline"><RefreshCw size={14}/> Recalculate</button>
        </div>
      </div>

      {/* Health summary */}
      <div className="fr-health">
        <div className="fr-health-score">
          <div className="fr-score-circle">
            <svg viewBox="0 0 100 100" width="90" height="90">
              <circle cx="50" cy="50" r="40" fill="none" stroke="#f3f4f6" strokeWidth="10"/>
              <circle cx="50" cy="50" r="40" fill="none" stroke="#10b981" strokeWidth="10"
                strokeDasharray={`${(goodCount/allRatios.length)*251} 251`}
                strokeLinecap="round" transform="rotate(-90 50 50)"/>
              <text x="50" y="46" textAnchor="middle" fontSize="18" fontWeight="700" fill="#111827">
                {Math.round((goodCount/allRatios.length)*100)}%
              </text>
              <text x="50" y="60" textAnchor="middle" fontSize="9" fill="#9ca3af">health</text>
            </svg>
          </div>
          <div>
            <h3 className="fr-health-title">Overall Financial Health</h3>
            <p className="fr-health-sub">Based on {allRatios.length} key ratios</p>
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

        {/* Trend chart */}
        <div className="fr-health-chart">
          <p className="fr-chart-title">Key Ratios Trend — Last 6 Months</p>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={TREND_DATA} margin={{top:5,right:10,left:0,bottom:0}}>
              <defs>
                <linearGradient id="crG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="nmG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
              <XAxis dataKey="month" tick={{fontSize:11}}/>
              <YAxis tick={{fontSize:10}}/>
              <Tooltip/>
              <Legend wrapperStyle={{fontSize:11}}/>
              <Area type="monotone" dataKey="currentRatio" stroke="#3b82f6"
                fill="url(#crG)" strokeWidth={2} name="Current Ratio" dot={false}/>
              <Area type="monotone" dataKey="netMargin" stroke="#10b981"
                fill="url(#nmG)" strokeWidth={2} name="Net Margin %" dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="fr-filter-tabs">
        {[
          {value:'all',          label:'All Ratios',      count:allRatios.length},
          {value:'liquidity',    label:'Liquidity',       count:RATIO_DATA.liquidity.ratios.length},
          {value:'profitability',label:'Profitability',   count:RATIO_DATA.profitability.ratios.length},
          {value:'solvency',     label:'Solvency',        count:RATIO_DATA.solvency.ratios.length},
          {value:'efficiency',   label:'Efficiency',      count:RATIO_DATA.efficiency.ratios.length},
        ].map(t=>(
          <button key={t.value}
            className={`fr-filter-tab${activeSection===t.value?' active':''}`}
            onClick={()=>setActiveSection(t.value)}>
            {t.label}
            <span className="fr-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {/* Ratio sections */}
      {sections.map(([key, section]) => (
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
                {section.ratios.filter(r=>r.rating==='danger').length} critical
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
        <span className="fr-chip fr-chip-warn"><AlertTriangle size={11}/> Warning — approaching threshold</span>
        <span className="fr-chip fr-chip-bad"><XCircle size={11}/> Critical — below safe level</span>
      </div>
    </div>
  );
}