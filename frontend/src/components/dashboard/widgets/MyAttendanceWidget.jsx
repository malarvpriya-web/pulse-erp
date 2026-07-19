export function MyAttendanceWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="status-badge">{data?.todayStatus || '—'}</div>
      {data?.lateAlert && <div className="alert-box warning">You were late today</div>}
      <div className="kpi-card">
        <span className="kpi-label">Monthly Attendance</span>
        <span className="kpi-value">{data?.monthlyRate || 0}%</span>
      </div>
    </div>
  );
}

export function MyLeaveWidget({ data }) {
  const leaves = data?.leaves || [];

  if (!leaves.length) {
    return (
      <div className="widget-data">
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>
          No leave balance data
        </p>
        <button className="btn-primary">Apply Leave</button>
      </div>
    );
  }

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
  const tasks = data?.tasks || [];

  return (
    <div className="widget-data">
      <div className="task-summary">
        <span className="task-count due-today">{data?.dueToday || 0} Due Today</span>
        <span className="task-count overdue">{data?.overdue || 0} Overdue</span>
      </div>
      {tasks.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '8px 0' }}>
          No open tasks
        </p>
      ) : (
        <div className="task-list">
          {tasks.slice(0, 3).map((task, idx) => (
            <div key={idx} className={`task-item priority-${task.priority}`}>
              <span className="task-title">{task.title}</span>
              <span className="task-due">{task.dueDate}</span>
            </div>
          ))}
        </div>
      )}
      <button className="btn-link">View All Tasks</button>
    </div>
  );
}

export function MyApprovalsWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="approval-status">
        <div className="status-item pending">
          <span className="status-count">{data?.pending || 0}</span>
          <span className="status-label">Pending</span>
        </div>
        <div className="status-item approved">
          <span className="status-count">{data?.approved || 0}</span>
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
        <p><strong>Latest Payslip:</strong> {data?.latestMonth || '—'}</p>
        {data?.amount != null && (
          <p className="payslip-amount">₹{Number(data.amount).toLocaleString('en-IN')}</p>
        )}
      </div>
      <button className="btn-primary">Download Payslip</button>
    </div>
  );
}

export function AnnouncementsWidget({ data }) {
  const announcements = data?.announcements || [];

  return (
    <div className="widget-data">
      {announcements.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>
          No announcements
        </p>
      ) : (
        <div className="announcement-list">
          {announcements.map((item, idx) => (
            <div key={idx} className="announcement-item">
              <span className="announcement-title">{item.title}</span>
              <span className="announcement-date">{item.date}</span>
            </div>
          ))}
        </div>
      )}
      {(data?.birthdays || data?.anniversaries) && (
        <div className="celebrations">
          {data.birthdays    && <p>🎂 <strong>Birthdays:</strong> {data.birthdays}</p>}
          {data.anniversaries && <p>🎉 <strong>Work Anniversary:</strong> {data.anniversaries}</p>}
        </div>
      )}
    </div>
  );
}

export function NotificationsWidget({ data }) {
  const alerts = data?.alerts || [];

  if (!alerts.length) {
    return (
      <div className="widget-data">
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>
          No alerts
        </p>
      </div>
    );
  }

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
