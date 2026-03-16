import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './AdvancedInventory.css';

const AdvancedInventoryDashboard = () => {
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState(null);
  const [reservedVsAvailable, setReservedVsAvailable] = useState([]);
  const [stockAging, setStockAging] = useState([]);
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    fetchDashboard();
    fetchReservedVsAvailable();
    fetchStockAging();
    fetchAlerts();
  }, []);

  const fetchDashboard = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/inventory/advanced/dashboard', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMetrics(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchReservedVsAvailable = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/inventory/advanced/reserved-vs-available', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setReservedVsAvailable(res.data.slice(0, 10));
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchStockAging = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/inventory/advanced/stock-aging', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setStockAging(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchAlerts = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/inventory/advanced/alerts?status=active', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setAlerts(res.data.slice(0, 5));
    } catch (error) {
      console.error('Error:', error);
    }
  };

  if (!metrics) return <div>Loading...</div>;

  const maxReserved = Math.max(...reservedVsAvailable.map(i => parseFloat(i.reserved_stock)), 1);

  return (
    <div className="adv-inv-page">
      <div className="page-header">
        <h1>Advanced Inventory Control</h1>
        <div className="header-actions">
          <button className="action-btn" onClick={() => navigate('/inventory/batches')}>Batch Tracking</button>
          <button className="action-btn" onClick={() => navigate('/inventory/reservations')}>Reservations</button>
          <button className="action-btn" onClick={() => navigate('/inventory/alerts')}>Stock Alerts</button>
        </div>
      </div>

      <div className="metrics-grid">
        <div className="metric-card red">
          <div className="metric-icon">⚠️</div>
          <div className="metric-content">
            <h3>Low Stock Alerts</h3>
            <p className="metric-value">{metrics.low_stock_alerts}</p>
          </div>
        </div>

        <div className="metric-card blue">
          <div className="metric-icon">📦</div>
          <div className="metric-content">
            <h3>Active Reservations</h3>
            <p className="metric-value">{metrics.active_reservations}</p>
          </div>
        </div>

        <div className="metric-card yellow">
          <div className="metric-icon">📋</div>
          <div className="metric-content">
            <h3>Purchase Suggestions</h3>
            <p className="metric-value">{metrics.pending_suggestions}</p>
          </div>
        </div>

        <div className="metric-card orange">
          <div className="metric-icon">⏰</div>
          <div className="metric-content">
            <h3>Expiring Batches</h3>
            <p className="metric-value">{metrics.expiring_batches}</p>
          </div>
        </div>

        <div className="metric-card green">
          <div className="metric-icon">💰</div>
          <div className="metric-content">
            <h3>Available Stock Value</h3>
            <p className="metric-value">${metrics.total_available_value.toLocaleString()}</p>
          </div>
        </div>

        <div className="metric-card purple">
          <div className="metric-icon">🔒</div>
          <div className="metric-content">
            <h3>Reserved Stock Value</h3>
            <p className="metric-value">${metrics.total_reserved_value.toLocaleString()}</p>
          </div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="dashboard-card">
          <h3>Reserved vs Available Stock (Top 10)</h3>
          <div className="chart-container">
            {reservedVsAvailable.map(item => (
              <div key={item.item_code} className="bar-item">
                <div className="bar-label">{item.item_code}</div>
                <div className="bar-wrapper">
                  <div className="bar-segment reserved" style={{ width: `${(parseFloat(item.reserved_stock) / maxReserved) * 100}%` }}>
                    <span>{item.reserved_stock}</span>
                  </div>
                  <div className="bar-segment available" style={{ width: `${(parseFloat(item.available_stock) / maxReserved) * 100}%` }}>
                    <span>{item.available_stock}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="legend">
            <span><span className="legend-box reserved"></span> Reserved</span>
            <span><span className="legend-box available"></span> Available</span>
          </div>
        </div>

        <div className="dashboard-card">
          <h3>Stock Aging Report</h3>
          <div className="aging-grid">
            {stockAging.map(age => (
              <div key={age.age_category} className="aging-card">
                <h4>{age.age_category}</h4>
                <p><strong>{age.batch_count}</strong> batches</p>
                <p>{parseFloat(age.total_quantity).toFixed(2)} units</p>
                <p className="value">${parseFloat(age.total_value).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <h2>Recent Stock Alerts</h2>
          <button className="action-btn" onClick={() => navigate('/inventory/alerts')}>View All</button>
        </div>
        <div className="alerts-list">
          {alerts.map(alert => (
            <div key={alert.id} className={`alert-card ${alert.alert_type}`}>
              <div className="alert-icon">
                {alert.alert_type === 'low_stock' && '⚠️'}
                {alert.alert_type === 'out_of_stock' && '🚫'}
                {alert.alert_type === 'expiring_soon' && '⏰'}
              </div>
              <div className="alert-content">
                <h4>{alert.item_name} ({alert.item_code})</h4>
                <p>{alert.warehouse_name}</p>
                <p className="alert-detail">
                  Available: {alert.available_stock} | Reserved: {alert.reserved_stock} | Reorder: {alert.reorder_level}
                </p>
              </div>
              <div className="alert-time">
                {new Date(alert.alert_date).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="action-grid">
        <div className="action-card" onClick={() => navigate('/inventory/batches')}>
          <h4>📦 Batch Tracking</h4>
          <p>Track material batches with expiry dates and supplier info</p>
        </div>
        <div className="action-card" onClick={() => navigate('/inventory/reservations')}>
          <h4>🔒 Stock Reservations</h4>
          <p>Reserve stock for projects and track consumption</p>
        </div>
        <div className="action-card" onClick={() => navigate('/inventory/purchase-suggestions')}>
          <h4>📋 Purchase Suggestions</h4>
          <p>Auto-generated purchase recommendations</p>
        </div>
        <div className="action-card" onClick={() => navigate('/inventory/material-consumption')}>
          <h4>📊 Material Consumption</h4>
          <p>Track material usage by project and department</p>
        </div>
      </div>
    </div>
  );
};

export default AdvancedInventoryDashboard;
