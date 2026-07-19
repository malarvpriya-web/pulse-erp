// Sample data for HR Analytics service — used as fallbacks in development only.
// Guard with import.meta.env.DEV at every usage site.

// ── hrAnalyticsApi — headcount summary ───────────────────────────────────────
export const SAMPLE_HEADCOUNT = {
  total: 247, active: 231, onLeave: 9, probation: 7,
  newHires: 12, departures: 5, growth: 4.8,
};

// ── hrAnalyticsApi — attrition summary ───────────────────────────────────────
export const SAMPLE_ATTRITION = {
  rate: 11.2, voluntary: 8.4, involuntary: 2.8,
  avgTenure: 2.7, atRisk: 14,
};

// ── hrAnalyticsApi — offer acceptance summary ─────────────────────────────────
export const SAMPLE_OFFER_ACCEPTANCE = { rate: 74, offered: 27, accepted: 20, declined: 7 };

// ── hrAnalyticsApi — absenteeism summary ─────────────────────────────────────
export const SAMPLE_ABSENTEEISM = { rate: 3.1, avgDays: 1.4, chronic: 5 };

// ── hrAnalyticsApi — attrition trend chart ───────────────────────────────────
export const SAMPLE_ATTRITION_TREND = [
  { month: 'Oct', rate: 9.8 }, { month: 'Nov', rate: 10.5 }, { month: 'Dec', rate: 10.1 },
  { month: 'Jan', rate: 11.8 }, { month: 'Feb', rate: 10.9 }, { month: 'Mar', rate: 11.2 },
];

// ── hrAnalyticsApi — hiring trend chart ──────────────────────────────────────
export const SAMPLE_HIRING_TREND = [
  { month: 'Oct', hired: 8,  departed: 4 },
  { month: 'Nov', hired: 12, departed: 3 },
  { month: 'Dec', hired: 6,  departed: 7 },
  { month: 'Jan', hired: 15, departed: 5 },
  { month: 'Feb', hired: 10, departed: 4 },
  { month: 'Mar', hired: 12, departed: 5 },
];

// ── hrAnalyticsApi — gender distribution ─────────────────────────────────────
export const SAMPLE_GENDER = [
  { name: 'Male',   value: 148 },
  { name: 'Female', value: 91  },
  { name: 'Other',  value: 8   },
];

// ── hrAnalyticsApi — department workforce ────────────────────────────────────
export const SAMPLE_DEPT_WORKFORCE = [
  { dept: 'Engineering', headcount: 62, target: 70 },
  { dept: 'Sales',       headcount: 45, target: 50 },
  { dept: 'HR',          headcount: 18, target: 20 },
  { dept: 'Finance',     headcount: 22, target: 25 },
  { dept: 'Operations',  headcount: 38, target: 40 },
  { dept: 'Marketing',   headcount: 24, target: 25 },
  { dept: 'Support',     headcount: 34, target: 35 },
];

// ── hrAnalyticsApi — productivity trend ──────────────────────────────────────
export const SAMPLE_PRODUCTIVITY = [
  { month: 'Oct', score: 72 }, { month: 'Nov', score: 74 },
  { month: 'Dec', score: 68 }, { month: 'Jan', score: 76 },
  { month: 'Feb', score: 79 }, { month: 'Mar', score: 81 },
];

// ── hrAnalyticsApi — top performers ──────────────────────────────────────────
export const SAMPLE_TOP_PERFORMERS = [
  { id: 1, name: 'Priya Sharma',    dept: 'Sales',       score: 96, rating: 'Exceptional' },
  { id: 2, name: 'Arjun Mehta',     dept: 'Engineering', score: 94, rating: 'Exceptional' },
  { id: 3, name: 'Neha Joshi',      dept: 'Marketing',   score: 91, rating: 'Exceeds' },
  { id: 4, name: 'Karthik Rajan',   dept: 'Operations',  score: 89, rating: 'Exceeds' },
  { id: 5, name: 'Sunita Mehta',    dept: 'Finance',     score: 88, rating: 'Exceeds' },
];

// ── hrAnalyticsApi — HR insights ─────────────────────────────────────────────
export const SAMPLE_INSIGHTS = [
  { type: 'warning', rule: 'high_attrition',       message: 'Attrition at 11.2% — above 10% threshold. Engineering dept leads exits.' },
  { type: 'info',    rule: 'low_offer_acceptance',  message: 'Offer acceptance at 74% — review compensation benchmarks.' },
  { type: 'success', rule: 'hiring_momentum',       message: '12 new hires in March, highest in 6 months.' },
  { type: 'warning', rule: 'workload_imbalance',    message: 'Engineering is 88% of headcount target vs HR at 90% — gaps widening.' },
];
