// ─── Fixtures for analytics/pages ─────────────────────────────────────────────
// Dev-only sample data. Import and wrap with import.meta.env.DEV guards.

// CeoDashboard.jsx
export const SAMPLE_KPI = {
  revenue:       { value: 4820000, growth: 14.2, label: 'Total Revenue (YTD)' },
  arr:           { value: 2160000, growth: 8.4,  label: 'ARR' },
  headcount:     { value: 247,     growth: 4.8,  label: 'Headcount' },
  attrition:     { value: 11.2,    growth: -2.1, label: 'Attrition Rate', unit:'%' },
  openPipeline:  { value: 9800000, growth: 22.0, label: 'Sales Pipeline' },
  projectsOnTrack:{ value: 18,     growth: 0,    label: 'Projects On-Track', outOf: 23 },
};

// CeoDashboard.jsx
export const SAMPLE_REVENUE = [
  { month:'Oct', revenue:3200000, target:3500000 },
  { month:'Nov', revenue:3800000, target:3500000 },
  { month:'Dec', revenue:3400000, target:3500000 },
  { month:'Jan', revenue:4100000, target:4000000 },
  { month:'Feb', revenue:4500000, target:4000000 },
  { month:'Mar', revenue:4820000, target:4500000 },
];

// CeoDashboard.jsx
export const SAMPLE_PIPELINE = [
  { stage:'Prospecting', value:3200000 },
  { stage:'Qualified',   value:2800000 },
  { stage:'Proposal',    value:1800000 },
  { stage:'Negotiation', value:1200000 },
  { stage:'Closed Won',  value:820000  },
];

// CeoDashboard.jsx
export const SAMPLE_HR = { totalEmp:247, onLeave:9, newHires:12, atRisk:14 };

// CeoDashboard.jsx
export const SAMPLE_PROJECTS = [
  { name:'ERP Migration',       status:'On Track',  health:88 },
  { name:'CRM Integration',     status:'At Risk',   health:52 },
  { name:'Mobile App v2',       status:'On Track',  health:76 },
  { name:'Data Warehouse',      status:'Delayed',   health:34 },
  { name:'API Platform',        status:'On Track',  health:91 },
];
