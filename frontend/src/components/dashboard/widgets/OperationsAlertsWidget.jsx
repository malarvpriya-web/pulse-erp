import React, { useState, useEffect } from 'react';
import { AlertTriangle, Ticket, Package } from 'lucide-react';
import { dashboardAPI } from '../../../services/api/dashboardAPI';
import './OperationsAlertsWidget.css';

const OperationsAlertsWidget = ({ title, apiEndpoint: _apiEndpoint, refreshKey }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

  const fetchData = async () => {
    try {

      setError(null);
      const response = await dashboardAPI.getOperationsAlerts();
      setData(response);
    } catch (err) {
      setError('Failed to load alerts');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="operations-alerts-widget">
        <h3 className="widget-title">{title}</h3>
        <div className="widget-loading">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="operations-alerts-widget">
        <h3 className="widget-title">{title}</h3>
        <div className="widget-error">{error}</div>
      </div>
    );
  }

  const { overdueTasks, openTickets, lowStockItems } = data || {};

  return (
    <div className="operations-alerts-widget">
      <h3 className="widget-title">{title}</h3>
      
      <div className="alert-item warning">
        <div className="alert-icon">
          <AlertTriangle size={24} color="#f59e0b" />
        </div>
        <div className="alert-content">
          <div className="alert-count">{overdueTasks?.count || 0}</div>
          <div className="alert-label">Overdue Tasks</div>
        </div>
        <button className="alert-action">View</button>
      </div>

      <div className="alert-item info">
        <div className="alert-icon">
          <Ticket size={24} color="#3b82f6" />
        </div>
        <div className="alert-content">
          <div className="alert-count">{openTickets?.count || 0}</div>
          <div className="alert-label">Open Tickets</div>
        </div>
        <button className="alert-action">View</button>
      </div>

      <div className="alert-item danger">
        <div className="alert-icon">
          <Package size={24} color="#ef4444" />
        </div>
        <div className="alert-content">
          <div className="alert-count">{lowStockItems?.count || 0}</div>
          <div className="alert-label">Low Stock Items</div>
        </div>
        <button className="alert-action">View</button>
      </div>
    </div>
  );
};

export default OperationsAlertsWidget;
