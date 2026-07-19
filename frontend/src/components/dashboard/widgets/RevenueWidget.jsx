const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000)      return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

export function RevenueWidget({ data }) {
  if (!data || (data.thisMonth == null && data.lastMonth == null && data.ytd == null)) {
    return (
      <div className="widget-data">
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
          No revenue data
        </p>
      </div>
    );
  }
  return (
    <div className="widget-data">
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">This Month</span>
          <span className="kpi-value">{fmt(data.thisMonth || 0)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Last Month</span>
          <span className="kpi-value">{fmt(data.lastMonth || 0)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">YTD</span>
          <span className="kpi-value">{fmt(data.ytd || 0)}</span>
        </div>
      </div>
    </div>
  );
}

export function ProfitabilityWidget({ data }) {
  if (!data || (data.grossProfit == null && data.netProfit == null)) {
    return (
      <div className="widget-data">
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
          No profitability data
        </p>
      </div>
    );
  }
  return (
    <div className="widget-data">
      <div className="kpi-card">
        <span className="kpi-label">Gross Profit</span>
        <span className="kpi-value">{fmt(data.grossProfit || 0)}</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Net Profit</span>
        <span className="kpi-value">{fmt(data.netProfit || 0)}</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Expenses</span>
        <span className="kpi-value">{fmt(data.expenses || 0)}</span>
      </div>
    </div>
  );
}

export function CashPositionWidget({ data }) {
  if (!data) {
    return (
      <div className="widget-data">
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
          No cash data
        </p>
      </div>
    );
  }
  return (
    <div className="widget-data">
      <div className="kpi-card large">
        <span className="kpi-label">Bank Balance</span>
        <span className="kpi-value large">{fmt(data.balance || 0)}</span>
      </div>
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Today Inflow</span>
          <span className="kpi-value positive">{fmt(data.inflow || 0)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Today Outflow</span>
          <span className="kpi-value negative">{fmt(data.outflow || 0)}</span>
        </div>
      </div>
      {data.upcomingPayments > 0 && (
        <div className="alert-box">
          <strong>Upcoming Payments:</strong> {fmt(data.upcomingPayments)} due in 7 days
        </div>
      )}
    </div>
  );
}

export function SalesPipelineWidget({ data }) {
  if (!data || (data.openDeals == null && data.wonDeals == null)) {
    return (
      <div className="widget-data">
        <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
          No pipeline data
        </p>
      </div>
    );
  }
  const winRate = data.winRate || 0;
  return (
    <div className="widget-data">
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Open Deals</span>
          <span className="kpi-value">{data.openDeals || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Won This Month</span>
          <span className="kpi-value positive">{data.wonDeals || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Lost This Month</span>
          <span className="kpi-value negative">{data.lostDeals || 0}</span>
        </div>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${winRate}%` }}></div>
      </div>
      <p className="progress-label">Win Rate: {winRate}%</p>
    </div>
  );
}

export function WorkforceWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Total Employees</span>
          <span className="kpi-value">{data?.total || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">New Hires</span>
          <span className="kpi-value positive">{data?.newHires || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Attrition</span>
          <span className="kpi-value negative">{data?.attrition || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Attendance Today</span>
          <span className="kpi-value">{data?.attendanceRate || 0}%</span>
        </div>
      </div>
    </div>
  );
}

export function OperationsWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Open Tickets</span>
          <span className="kpi-value">{data?.openTickets || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Active Projects</span>
          <span className="kpi-value">{data?.activeProjects || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Overdue Tasks</span>
          <span className="kpi-value negative">{data?.overdueTasks || 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Low Stock Alerts</span>
          <span className="kpi-value warning">{data?.lowStockAlerts || 0}</span>
        </div>
      </div>
    </div>
  );
}

export default RevenueWidget;
