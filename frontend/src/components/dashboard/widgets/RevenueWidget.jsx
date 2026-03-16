export function RevenueWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">This Month</span>
          <span className="kpi-value">${data?.thisMonth?.toLocaleString() || "90,000"}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Last Month</span>
          <span className="kpi-value">${data?.lastMonth?.toLocaleString() || "80,000"}</span>
          <span className="kpi-change positive">+12.5%</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">YTD</span>
          <span className="kpi-value">${data?.ytd?.toLocaleString() || "405,000"}</span>
        </div>
      </div>
    </div>
  );
}

export function ProfitabilityWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-card">
        <span className="kpi-label">Gross Profit</span>
        <span className="kpi-value">${data?.grossProfit?.toLocaleString() || "45,000"}</span>
        <span className="kpi-change positive">+8%</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Net Profit</span>
        <span className="kpi-value">${data?.netProfit?.toLocaleString() || "28,000"}</span>
        <span className="kpi-change positive">+5%</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Expenses</span>
        <span className="kpi-value">${data?.expenses?.toLocaleString() || "17,000"}</span>
        <span className="kpi-change negative">+3%</span>
      </div>
    </div>
  );
}

export function CashPositionWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-card large">
        <span className="kpi-label">Bank Balance</span>
        <span className="kpi-value large">${data?.balance?.toLocaleString() || "250,000"}</span>
      </div>
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Today Inflow</span>
          <span className="kpi-value positive">${data?.inflow?.toLocaleString() || "12,000"}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Today Outflow</span>
          <span className="kpi-value negative">${data?.outflow?.toLocaleString() || "8,500"}</span>
        </div>
      </div>
      <div className="alert-box">
        <strong>Upcoming Payments:</strong> ${data?.upcomingPayments?.toLocaleString() || "45,000"} due in 7 days
      </div>
    </div>
  );
}

export function SalesPipelineWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Open Deals</span>
          <span className="kpi-value">{data?.openDeals || 24}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Won This Month</span>
          <span className="kpi-value positive">{data?.wonDeals || 8}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Lost This Month</span>
          <span className="kpi-value negative">{data?.lostDeals || 2}</span>
        </div>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${data?.winRate || 80}%` }}></div>
      </div>
      <p className="progress-label">Win Rate: {data?.winRate || 80}%</p>
    </div>
  );
}

export function WorkforceWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Total Employees</span>
          <span className="kpi-value">{data?.total || 150}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">New Hires</span>
          <span className="kpi-value positive">{data?.newHires || 5}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Attrition</span>
          <span className="kpi-value negative">{data?.attrition || 2}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Attendance Today</span>
          <span className="kpi-value">{data?.attendanceRate || 94}%</span>
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
          <span className="kpi-value">{data?.openTickets || 12}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Active Projects</span>
          <span className="kpi-value">{data?.activeProjects || 8}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Overdue Tasks</span>
          <span className="kpi-value negative">{data?.overdueTasks || 5}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Low Stock Alerts</span>
          <span className="kpi-value warning">{data?.lowStockAlerts || 3}</span>
        </div>
      </div>
    </div>
  );
}

export default RevenueWidget;
