export function TeamAttendanceWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="attendance-summary">
        <div className="attendance-stat present">
          <span className="stat-value">{data?.present || 18}</span>
          <span className="stat-label">Present</span>
        </div>
        <div className="attendance-stat absent">
          <span className="stat-value">{data?.absent || 2}</span>
          <span className="stat-label">Absent</span>
        </div>
        <div className="attendance-stat late">
          <span className="stat-value">{data?.late || 1}</span>
          <span className="stat-label">Late</span>
        </div>
      </div>
    </div>
  );
}

export function PendingApprovalsWidget({ data }) {
  const approvals = data?.approvals || [
    { type: "Leave", count: 5 },
    { type: "Expense", count: 3 },
    { type: "Purchase", count: 2 },
    { type: "Timesheet", count: 8 }
  ];

  return (
    <div className="widget-data">
      <div className="approval-list">
        {approvals.map((item, idx) => (
          <div key={idx} className="approval-item">
            <span className="approval-type">{item.type}</span>
            <span className="approval-count">{item.count}</span>
          </div>
        ))}
      </div>
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
          <span className="kpi-value">{data?.activeProjects || 6}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Overdue Tasks</span>
          <span className="kpi-value negative">{data?.overdueTasks || 4}</span>
        </div>
      </div>
      <div className="budget-bar">
        <div className="budget-label">Budget vs Actual</div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${data?.budgetUsed || 75}%` }}></div>
        </div>
        <p className="progress-label">{data?.budgetUsed || 75}% utilized</p>
      </div>
    </div>
  );
}

export function TeamPerformanceWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-card">
        <span className="kpi-label">Team Utilization</span>
        <span className="kpi-value">{data?.utilization || 87}%</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Goal Completion</span>
        <span className="kpi-value">{data?.goalCompletion || 92}%</span>
      </div>
    </div>
  );
}

export function DeptSpendWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-card">
        <span className="kpi-label">Monthly Spend</span>
        <span className="kpi-value">${data?.monthlySpend?.toLocaleString() || "23,500"}</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Budget</span>
        <span className="kpi-value">${data?.budget?.toLocaleString() || "30,000"}</span>
      </div>
    </div>
  );
}

export default TeamAttendanceWidget;
