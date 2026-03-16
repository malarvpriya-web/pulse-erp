export function MyAttendanceWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="status-badge">{data?.todayStatus || "Present"}</div>
      {data?.lateAlert && <div className="alert-box warning">You were late today</div>}
      <div className="kpi-card">
        <span className="kpi-label">Monthly Attendance</span>
        <span className="kpi-value">{data?.monthlyRate || 95}%</span>
      </div>
    </div>
  );
}

export function MyLeaveWidget({ data }) {
  const leaves = data?.leaves || [
    { type: "Annual", balance: 12 },
    { type: "Sick", balance: 5 },
    { type: "Casual", balance: 3 }
  ];

  return (
    <div className="widget-data">
      <div className="leave-balances">
        {leaves.map((leave, idx) => (
          <div key={idx} className="leave-item">
            <span className="leave-type">{leave.type}</span>
            <span className="leave-balance">{leave.balance} days</span>
          </div>
        ))}
      </div>
      {data?.upcomingLeaves && (
        <div className="upcoming-leaves">
          <strong>Upcoming:</strong> {data.upcomingLeaves}
        </div>
      )}
      <button className="btn-primary">Apply Leave</button>
    </div>
  );
}

export function MyTasksWidget({ data }) {
  const tasks = data?.tasks || [
    { title: "Complete project report", dueDate: "Today", priority: "high" },
    { title: "Review code changes", dueDate: "Tomorrow", priority: "medium" },
    { title: "Team meeting prep", dueDate: "Today", priority: "low" }
  ];

  return (
    <div className="widget-data">
      <div className="task-summary">
        <span className="task-count due-today">{data?.dueToday || 2} Due Today</span>
        <span className="task-count overdue">{data?.overdue || 1} Overdue</span>
      </div>
      <div className="task-list">
        {tasks.slice(0, 3).map((task, idx) => (
          <div key={idx} className={`task-item priority-${task.priority}`}>
            <span className="task-title">{task.title}</span>
            <span className="task-due">{task.dueDate}</span>
          </div>
        ))}
      </div>
      <button className="btn-link">View All Tasks</button>
    </div>
  );
}

export function MyApprovalsWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="approval-status">
        <div className="status-item pending">
          <span className="status-count">{data?.pending || 2}</span>
          <span className="status-label">Pending</span>
        </div>
        <div className="status-item approved">
          <span className="status-count">{data?.approved || 5}</span>
          <span className="status-label">Approved</span>
        </div>
        <div className="status-item rejected">
          <span className="status-count">{data?.rejected || 0}</span>
          <span className="status-label">Rejected</span>
        </div>
      </div>
    </div>
  );
}

export function MyPayslipsWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="payslip-info">
        <p><strong>Latest Payslip:</strong> {data?.latestMonth || "December 2024"}</p>
        <p className="payslip-amount">${data?.amount?.toLocaleString() || "5,500"}</p>
      </div>
      <button className="btn-primary">Download Payslip</button>
    </div>
  );
}

export function AnnouncementsWidget({ data }) {
  const announcements = data?.announcements || [
    { title: "Holiday Notice", date: "2 days ago" },
    { title: "New Policy Update", date: "1 week ago" }
  ];

  return (
    <div className="widget-data">
      <div className="announcement-list">
        {announcements.map((item, idx) => (
          <div key={idx} className="announcement-item">
            <span className="announcement-title">{item.title}</span>
            <span className="announcement-date">{item.date}</span>
          </div>
        ))}
      </div>
      <div className="celebrations">
        <p>🎂 <strong>Birthdays:</strong> {data?.birthdays || "John (Today)"}</p>
        <p>🎉 <strong>Work Anniversary:</strong> {data?.anniversaries || "Sarah (5 years)"}</p>
      </div>
    </div>
  );
}

export function NotificationsWidget({ data }) {
  const alerts = data?.alerts || [
    { type: "approval", message: "2 pending approvals", priority: "high" },
    { type: "leave", message: "Low leave balance", priority: "medium" }
  ];

  return (
    <div className="widget-data">
      <div className="notification-list">
        {alerts.map((alert, idx) => (
          <div key={idx} className={`notification-item priority-${alert.priority}`}>
            <span className="notification-icon">🔔</span>
            <span className="notification-message">{alert.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default MyAttendanceWidget;
