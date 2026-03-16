import { useState, useEffect } from "react";
import api from "@/services/api/client";
import Widget from "@/components/dashboard/Widget";
import { getWidgetsForRole } from "../config/dashboardConfig";
import "./ERPDashboard.css";


function ERPDashboard() {
  const [user, setUser] = useState(null);
  const [widgets, setWidgets] = useState([]);
  const [dashboardData, setDashboardData] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUserAndDashboard();
  }, []);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  };

  const formatDate = (date) => {
    const day = String(date.getDate()).padStart(2, '0');
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
  };

  const getRecentActivities = () => {
    return [
      { id: 1, icon: '📝', description: 'John applied for leave', time: '2 hours ago' },
      { id: 2, icon: '✔️', description: 'Manager approved leave request', time: '1 hour ago' },
      { id: 3, icon: '👤', description: 'New employee Rahul added to Sales', time: '3 hours ago' },
      { id: 4, icon: '📦', description: 'Purchase order PO-1021 approved', time: '4 hours ago' },
      { id: 5, icon: '🔧', description: 'Service ticket #203 closed', time: '5 hours ago' },
      { id: 6, icon: '💰', description: 'Vendor payment ₹45,000 approved', time: '6 hours ago' }
    ];
  };

  const fetchUserAndDashboard = async () => {
    try {
      const userRes = await api.get("/dashboard");
      const userData = userRes.data.user;
      setUser(userData);

      const savedLayout = localStorage.getItem(`dashboard_${userData.id}`);
      const role = userData.role?.toLowerCase().replace(" ", "");
const roleWidgets = getWidgetsForRole(role);
      
      if (savedLayout) {
        const parsed = JSON.parse(savedLayout);
        setWidgets(parsed.filter(w => roleWidgets.some(rw => rw.id === w.id)));
      } else {
        setWidgets(roleWidgets);
      }

      const dataRes = await api.get("/dashboard/data");
      setDashboardData(dataRes.data);
      setLoading(false);
    } catch (err) {
      console.error("Dashboard fetch error:", err);
      setLoading(false);
    }
  };

  const toggleWidget = (widgetId) => {
    setWidgets((prev) => {
      const updated = prev.map((w) =>
        w.id === widgetId ? { ...w, hidden: !w.hidden } : w
      );
      localStorage.setItem(`dashboard_${user.id}`, JSON.stringify(updated));
      return updated;
    });
  };

  const resetLayout = () => {
    const roleWidgets = getWidgetsForRole(user.role);
    setWidgets(roleWidgets);
    localStorage.removeItem(`dashboard_${user.id}`);
  };

    return (
    <div className="erp-dashboard">
      <div className="dashboard-header">
        <div>
          <h1>{getGreeting()}</h1>
          <p className="dashboard-date"> {formatDate(new Date())}</p>
        </div>
        <div className="dashboard-actions">
          <button className="btn-secondary" onClick={resetLayout}>Reset Layout</button>
        </div>
      </div>

     

      <div className="widget-controls">
        {widgets.map((w) => (
          <label key={w.id} className="widget-toggle">
            <input type="checkbox" checked={!w.hidden} onChange={() => toggleWidget(w.id)} />
            <span>{w.title}</span>
          </label>
        ))}
      </div>

     <div className="dashboard-layout">

  <div className="dashboard-row">
    {widgets.filter(w => !w.hidden && w.row === 1).map(widget => (
      <Widget key={widget.id} widget={widget} data={dashboardData[widget.dataKey]} />
    ))}
  </div>

  <div className="dashboard-row">
    {widgets.filter(w => !w.hidden && w.row === 2).map(widget => (
      <Widget key={widget.id} widget={widget} data={dashboardData[widget.dataKey]} />
    ))}
  </div>

</div>
       <div className="recent-activity-panel">
        <h2 className="activity-title">Recent Activity</h2>
        <div className="activity-list">
          {getRecentActivities().map((activity) => (
            <div key={activity.id} className="activity-item">
              <div className="activity-content">
                <span className="activity-icon">{activity.icon}</span>
                <span className="activity-description">{activity.description}</span>
              </div>
              <span className="activity-time">{activity.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ERPDashboard;
