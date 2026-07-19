export function TeamAttendanceWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="attendance-summary">
        <div className="attendance-stat present">
          <span className="stat-value">{data?.present || 0}</span>
          <span className="stat-label">Present</span>
        </div>
        <div className="attendance-stat absent">
          <span className="stat-value">{data?.absent || 0}</span>
          <span className="stat-label">Absent</span>
        </div>
        <div className="attendance-stat late">
          <span className="stat-value">{data?.late || 0}</span>
          <span className="stat-label">Late</span>
        </div>
      </div>
    </div>
  );
}

export function PendingApprovalsWidget({ data }) {
  const approvals = data?.approvals || [];

  return (
    <div className="widget-data">
      {approvals.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>
          No pending approvals
        </p>
      ) : (
        <div className="approval-list">
          {approvals.map((item, idx) => (
            <div key={idx} className="approval-item">
              <span className="approval-type">{item.type}</span>
              <span className="approval-count">{item.count}</span>
            </div>
          ))}
        </div>
      )}
      <button className="btn-primary">View All Approvals</button>
    </div>
  );
}

export function ProjectHealthWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Active Projects</span>
          <span className="kpi-value">{data?.activeProjects || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Overdue Tasks</span>
          <span className="kpi-value negative">{data?.overdueTasks || 0}</span>
        </div>
      </div>
      {data?.budgetUsed != null && (
        <div className="budget-bar">
          <div className="budget-label">Budget vs Actual</div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${data.budgetUsed}%` }}></div>
          </div>
          <p className="progress-label">{data.budgetUsed}% utilized</p>
        </div>
      )}
    </div>
  );
}

export function TeamPerformanceWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-card">
        <span className="kpi-label">Team Utilization</span>
        <span className="kpi-value">{data?.utilization || 0}%</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Goal Completion</span>
        <span className="kpi-value">{data?.goalCompletion || 0}%</span>
      </div>
    </div>
  );
}

const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000)      return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

export function DeptSpendWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-card">
        <span className="kpi-label">Monthly Spend</span>
        <span className="kpi-value">{fmt(data?.monthlySpend || 0)}</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Budget</span>
        <span className="kpi-value">{fmt(data?.budget || 0)}</span>
      </div>
    </div>
  );
}

export default TeamAttendanceWidget;
