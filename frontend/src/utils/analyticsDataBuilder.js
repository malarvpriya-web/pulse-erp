/**
 * analyticsDataBuilder.js
 * Pure builder functions that transform raw API payloads into
 * the exact prop shapes expected by each analytics panel.
 * No side-effects, no API calls, no React imports.
 */

// ─── HELPERS ────────────────────────────────────────────────────────────────

function _pct(num, den) {
  if (!den || den === 0) return 0;
  return Math.round((num / den) * 100);
}

function _currency(value) {
  if (value == null) return '—';
  if (Math.abs(value) >= 1e7) return `₹${(value / 1e7).toFixed(1)} Cr`;
  if (Math.abs(value) >= 1e5) return `₹${(value / 1e5).toFixed(1)} L`;
  if (Math.abs(value) >= 1e3) return `₹${(value / 1e3).toFixed(0)} K`;
  return `₹${value}`;
}

// ─── DESCRIPTIVE ─────────────────────────────────────────────────────────────

/**
 * Build data for DescriptivePanel.
 * @param {Object} raw — raw API response (varies by module)
 * @param {string} period — display period label
 * @returns {{ period, metrics[], highlights[] }}
 */
export function buildDescriptiveData(raw = {}, period = 'This Month') {
  const {
    headcount = 0, prev_headcount = 0,
    revenue = 0, prev_revenue = 0,
    attrition_rate = 0, prev_attrition_rate = 0,
    avg_salary = 0, prev_avg_salary = 0,
    open_positions = 0, prev_open_positions = 0,
    leaves_taken = 0, prev_leaves_taken = 0,
    utilization = 0, prev_utilization = 0,
    billable_hours = 0, prev_billable_hours = 0,
  } = raw;

  const metrics = [
    { label: 'Total Headcount',    value: headcount,       prev: prev_headcount,       format: 'number',   trendGoodWhenDown: false },
    { label: 'Revenue',            value: revenue,         prev: prev_revenue,          format: 'currency',  trendGoodWhenDown: false },
    { label: 'Attrition Rate',     value: attrition_rate,  prev: prev_attrition_rate,   format: 'percent',   trendGoodWhenDown: true  },
    { label: 'Avg Salary (CTC)',   value: avg_salary,      prev: prev_avg_salary,        format: 'currency',  trendGoodWhenDown: false },
    { label: 'Open Positions',     value: open_positions,  prev: prev_open_positions,   format: 'number',   trendGoodWhenDown: true  },
    { label: 'Leaves Taken',       value: leaves_taken,    prev: prev_leaves_taken,      format: 'number',   trendGoodWhenDown: true  },
    { label: 'Utilization %',      value: utilization,     prev: prev_utilization,       format: 'percent',   trendGoodWhenDown: false },
    { label: 'Billable Hours',     value: billable_hours,  prev: prev_billable_hours,    format: 'number',   trendGoodWhenDown: false },
  ].filter(m => m.value != null && m.value !== 0);

  const highlights = generateHighlights(metrics, period);

  return { period, metrics, highlights };
}

// ─── DIAGNOSTIC ──────────────────────────────────────────────────────────────

/**
 * Build data for DiagnosticPanel.
 * @param {Object} raw
 * @returns {{ anomalies[], correlations[] }}
 */
export function buildDiagnosticData(raw = {}) {
  const anomalies    = (raw.anomalies || []).map((a, i) => ({ id: a.id || i, ...a }));
  const correlations = raw.correlations || [];
  return { anomalies, correlations };
}

// ─── PREDICTIVE ──────────────────────────────────────────────────────────────

/**
 * Build data for PredictivePanel.
 * @param {Object} raw
 * @returns {{ forecast_series[], attrition_risks[], summary_stats{} }}
 */
export function buildPredictiveData(raw = {}) {
  const forecast_series  = raw.forecast_series  || [];
  const attrition_risks  = raw.attrition_risks  || [];

  const totalAtRisk  = attrition_risks.filter(e => e.risk_level === 'high').length;
  const avgForecast  = forecast_series.filter(d => d.forecast != null).length > 0
    ? Math.round(forecast_series.filter(d => d.forecast != null).reduce((s, d) => s + d.forecast, 0)
        / forecast_series.filter(d => d.forecast != null).length)
    : null;

  const summary_stats = {
    at_risk:     { label: 'High-Risk Employees', value: totalAtRisk,  note: 'Likely to leave in 90d' },
    forecast_hc: { label: 'Forecasted Headcount', value: avgForecast ?? '—', note: 'Avg over next 3 months' },
    ...(raw.summary_stats || {}),
  };

  return { forecast_series, attrition_risks, summary_stats };
}

// ─── PRESCRIPTIVE ────────────────────────────────────────────────────────────

/**
 * Build data for PrescriptivePanel.
 * @param {Object} raw
 * @returns {{ recommendations[], summary{} }}
 */
export function buildPrescriptiveData(raw = {}) {
  const recommendations = (raw.recommendations || []).map((r, i) => ({
    id: r.id || `rec-${i}`,
    status: r.status || 'pending',
    ...r,
  }));

  const total    = recommendations.length;
  const critical = recommendations.filter(r => r.priority === 'critical').length;
  const auto     = recommendations.filter(r => r.auto_executable).length;
  const pending  = recommendations.filter(r => !r.status || r.status === 'pending').length;

  const summary = {
    total:    { label: 'Total',         value: total },
    critical: { label: 'Critical',      value: critical },
    auto:     { label: 'Auto-Executable', value: auto },
    pending:  { label: 'Pending Action', value: pending },
  };

  return { recommendations, summary };
}

// ─── AUTONOMOUS ALERTS ───────────────────────────────────────────────────────

/**
 * Build data for AutonomousAlerts.
 * @param {Object} raw
 * @returns {{ alerts[], stats{} }}
 */
export function buildAutonomousAlerts(raw = {}) {
  const alerts = (raw.alerts || []).map((a, i) => ({
    id: a.id || `alert-${i}`,
    status: a.status || 'pending',
    severity: a.severity || 'medium',
    triggered_at: a.triggered_at || new Date().toISOString(),
    ...a,
  }));

  const pending       = alerts.filter(a => a.status === 'pending').length;
  const autoExecuted  = alerts.filter(a => a.status === 'auto_executed').length;
  const resolved      = alerts.filter(a => a.status === 'resolved').length;
  const failed        = alerts.filter(a => a.status === 'failed').length;

  const stats = {
    pending:      { label: 'Pending Approval', value: pending,      color: '#854d0e' },
    auto_executed:{ label: 'Auto-Executed',     value: autoExecuted, color: '#15803d' },
    resolved:     { label: 'Resolved',          value: resolved,     color: '#0369a1' },
    failed:       { label: 'Failed',            value: failed,       color: '#dc2626' },
  };

  return { alerts, stats };
}

// ─── HIGHLIGHTS GENERATOR ────────────────────────────────────────────────────

/**
 * Generate natural-language highlights from metric array.
 * @param {Array}  metrics
 * @param {string} period
 * @returns {string[]}
 */
export function generateHighlights(metrics = [], period = 'this period') {
  const lines = [];

  metrics.forEach(m => {
    if (m.prev == null || m.prev === 0) return;
    const change = ((m.value - m.prev) / m.prev) * 100;
    const abs    = Math.abs(change).toFixed(1);
    const dir    = change >= 0 ? 'increased' : 'decreased';
    const good   = m.trendGoodWhenDown ? change < 0 : change >= 0;
    const emoji  = good ? '✅' : '⚠️';

    if (Math.abs(change) >= 3) {
      lines.push(`${emoji} ${m.label} ${dir} by ${abs}% compared to the previous period.`);
    }
  });

  if (lines.length === 0) {
    lines.push(`📊 Metrics are stable with minimal change from the previous ${period.toLowerCase()}.`);
  }

  return lines;
}

// ─── SAMPLE DATA ─────────────────────────────────────────────────────────────
// Used as fallback when API returns empty/error responses.

export const SAMPLE_DESCRIPTIVE_RAW = {
  headcount: 247, prev_headcount: 239,
  revenue: 4200000, prev_revenue: 3850000,
  attrition_rate: 8.4, prev_attrition_rate: 11.2,
  avg_salary: 850000, prev_avg_salary: 820000,
  open_positions: 14, prev_open_positions: 11,
  leaves_taken: 312, prev_leaves_taken: 289,
  utilization: 82, prev_utilization: 78,
  billable_hours: 4680, prev_billable_hours: 4420,
};

export const SAMPLE_DIAGNOSTIC_RAW = {
  anomalies: [
    {
      id: 'a1', metric: 'Leave Requests', severity: 'high',
      time_detected: new Date(Date.now() - 3 * 3600000).toISOString(),
      observed: '47', expected: '28', deviation: '+19',
      possible_causes: [
        { cause: 'Post-appraisal dissatisfaction', probability: 0.72 },
        { cause: 'Seasonal demand (Q4 burnout)',   probability: 0.55 },
        { cause: 'Competing offer / market pull',  probability: 0.38 },
      ],
      affected_depts: ['Engineering', 'Design'],
    },
    {
      id: 'a2', metric: 'Overtime Hours', severity: 'critical',
      time_detected: new Date(Date.now() - 12 * 3600000).toISOString(),
      observed: '1,840 hrs', expected: '960 hrs', deviation: '+880 hrs',
      possible_causes: [
        { cause: 'Understaffing in key projects',  probability: 0.85 },
        { cause: 'Deadline crunch — Q4 delivery',  probability: 0.68 },
        { cause: 'Unplanned scope increase',       probability: 0.44 },
      ],
      affected_depts: ['Engineering', 'QA', 'DevOps'],
    },
    {
      id: 'a3', metric: 'Offer Rejections', severity: 'medium',
      time_detected: new Date(Date.now() - 2 * 86400000).toISOString(),
      observed: '6', expected: '2', deviation: '+4',
      possible_causes: [
        { cause: 'Below-market salary bands',      probability: 0.62 },
        { cause: 'Competitor counter-offers',      probability: 0.48 },
      ],
      affected_depts: ['Talent Acquisition'],
    },
  ],
  correlations: [
    { factor_a: 'Overtime Hours',   factor_b: 'Attrition',        correlation: 0.78, insight: 'Prolonged overtime strongly predicts 90-day attrition.' },
    { factor_a: 'Training Hours',   factor_b: 'Performance Score', correlation: 0.65, insight: 'Employees with >20 hrs training score 18% higher.' },
    { factor_a: 'Sick Leave Days',  factor_b: 'Productivity',     correlation: -0.58, insight: 'High sick leave correlates with lower output metrics.' },
    { factor_a: 'Salary Percentile',factor_b: 'Retention',        correlation: 0.71, insight: 'Employees above 60th percentile leave 3× less often.' },
  ],
};

export const SAMPLE_PREDICTIVE_RAW = {
  forecast_series: [
    { period: 'Oct', actual: 231 },
    { period: 'Nov', actual: 238 },
    { period: 'Dec', actual: 241 },
    { period: 'Jan', actual: 244 },
    { period: 'Feb', actual: 247 },
    { period: 'Mar', actual: 247, forecast: 247 },
    { period: 'Apr', forecast: 251, low: 246, high: 256 },
    { period: 'May', forecast: 255, low: 248, high: 262 },
    { period: 'Jun', forecast: 258, low: 249, high: 267 },
  ],
  attrition_risks: [
    { name: 'Arjun Mehta',      department: 'Engineering',   role: 'Senior Dev',       risk_level: 'high',   probability: 82, key_factor: 'Overtime spike + no promotion in 18 months' },
    { name: 'Priya Nair',       department: 'Design',        role: 'UI/UX Lead',       risk_level: 'high',   probability: 74, key_factor: '3 rejected leave requests in 60 days' },
    { name: 'Rahul Sharma',     department: 'Sales',         role: 'Sr. Executive',    risk_level: 'medium', probability: 55, key_factor: 'Below-band salary, competitor activity' },
    { name: 'Kavitha Rajan',    department: 'Finance',       role: 'Analyst',          risk_level: 'medium', probability: 48, key_factor: 'Frequent late logins + reduced output' },
    { name: 'Dev Patel',        department: 'DevOps',        role: 'Cloud Engineer',   risk_level: 'low',    probability: 31, key_factor: 'Market demand spike for cloud skills' },
  ],
};

export const SAMPLE_PRESCRIPTIVE_RAW = {
  recommendations: [
    {
      id: 'r1', priority: 'critical', category: 'Retention',
      title: 'Immediate Retention Intervention — Engineering Team',
      problem: '5 senior engineers show >70% attrition probability. Combined replacement cost estimated at ₹38 L.',
      recommendation: 'Schedule 1:1 retention conversations with each at-risk employee. Propose accelerated promotion review and spot bonus of ₹50,000 for engineers with 18+ months without increment.',
      impact_score: 78, impact_label: '78% estimated retention improvement',
      auto_executable: false,
      actions: [
        { type: 'schedule', label: 'Schedule 1:1s', auto: false },
        { type: 'notify',   label: 'Notify HR Manager', auto: true },
      ],
      affected: ['Arjun Mehta', 'Priya Nair', '+3 others'],
      status: 'pending',
    },
    {
      id: 'r2', priority: 'high', category: 'Hiring',
      title: 'Backfill 4 Open Positions — DevOps',
      problem: 'DevOps team is operating at 68% capacity. Current ticket SLA breach rate is 22%.',
      recommendation: 'Approve 4 new headcount requisitions. Prioritise internal transfers from QA team (2) and external hire (2) via existing recruitment partner agreements.',
      impact_score: 62, impact_label: '↓ SLA breach by ~60%',
      auto_executable: false,
      actions: [
        { type: 'approve',  label: 'Raise Requisition', auto: false },
        { type: 'notify',   label: 'Alert TA Team', auto: true },
      ],
      affected: ['DevOps', 'QA'],
      status: 'pending',
    },
    {
      id: 'r3', priority: 'medium', category: 'Training',
      title: 'Mandatory Burnout-Prevention Workshop',
      problem: 'Overtime hours are 92% above baseline for 3 consecutive weeks across 38 employees.',
      recommendation: 'Enrol impacted employees in a 4-hour digital wellbeing workshop. Enforce a 45-hour/week cap in project tracking tools. Auto-flag breach to manager.',
      impact_score: 54, impact_label: '↓ Overtime by ~35%',
      auto_executable: true,
      actions: [
        { type: 'train',    label: 'Enrol in Workshop', auto: true },
        { type: 'schedule', label: 'Set Overtime Cap',  auto: true },
      ],
      affected: ['Engineering', 'QA', 'DevOps'],
      status: 'pending',
    },
    {
      id: 'r4', priority: 'low', category: 'Compensation',
      title: 'Salary Band Review — Below-Market Roles',
      problem: '12 employees are below the 40th market percentile. Risk of counter-offers during appraisal season.',
      recommendation: 'Initiate compensation benchmarking exercise with payroll. Propose 8-12% correction for identified employees in the next payroll cycle.',
      impact_score: 44, impact_label: '↑ Market competitiveness',
      auto_executable: false,
      actions: [
        { type: 'review',   label: 'Start Benchmarking', auto: false },
      ],
      affected: ['Sales', 'Finance', 'Support'],
      status: 'in_progress',
    },
  ],
};

export const SAMPLE_AUTONOMOUS_ALERTS_RAW = {
  alerts: [
    {
      id: 'al1', title: 'Expense Report Auto-Approved',
      severity: 'low', status: 'auto_executed', module: 'Finance',
      triggered_at: new Date(Date.now() - 25 * 60000).toISOString(),
      description: '14 expense reports under ₹5,000 each were automatically approved per policy rules.',
      auto_action: 'Auto-approved 14 reports totalling ₹42,800. Notifications sent to submitters.',
      affected: ['Anita Roy', 'Suresh Kumar', '+12 others'],
    },
    {
      id: 'al2', title: 'Overtime Threshold Exceeded',
      severity: 'high', status: 'pending', module: 'Timesheets',
      triggered_at: new Date(Date.now() - 2 * 3600000).toISOString(),
      description: '8 employees logged >50 hours this week. Policy requires manager approval beyond 45 hours.',
      pending_action: 'Send overtime cap alert to 8 employees + their managers and flag for payroll adjustment.',
      affected: ['Engineering (5)', 'QA (2)', 'DevOps (1)'],
    },
    {
      id: 'al3', title: 'Leave Balance Auto-Reset',
      severity: 'medium', status: 'auto_executed', module: 'Leaves',
      triggered_at: new Date(Date.now() - 6 * 3600000).toISOString(),
      description: 'Annual leave balances reset for all employees at FY start per HR policy.',
      auto_action: 'Carry-forward calculated (max 10 days). 247 employee records updated. Email sent to all.',
      affected: ['All Employees'],
    },
    {
      id: 'al4', title: 'Candidate Pipeline Stalled',
      severity: 'medium', status: 'pending', module: 'Recruitment',
      triggered_at: new Date(Date.now() - 18 * 3600000).toISOString(),
      description: '6 candidates have been in "Interview Scheduled" stage for >10 days with no action.',
      pending_action: 'Send reminder to interviewers for feedback submission. Escalate 2 overdue cases to HR Head.',
      affected: ['Sneha M.', 'Vikram P.', '+4 others'],
    },
    {
      id: 'al5', title: 'Payroll Data Validation Complete',
      severity: 'low', status: 'resolved', module: 'Payroll',
      triggered_at: new Date(Date.now() - 86400000).toISOString(),
      description: 'Monthly payroll validation ran automatically. 2 anomalies detected and corrected.',
      auto_action: 'Corrected salary mismatch for 2 employees. Payroll cleared for processing.',
      affected: ['Finance Team'],
    },
  ],
};
