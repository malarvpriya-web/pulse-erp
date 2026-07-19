import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './AdvancedInventory.css';
import { useToast } from '@/context/ToastContext';

const StockAlertsAndSuggestions = ({ setPage }) => {
  const toast = useToast();
  const { user } = useAuth();
  const uid = user?.employee_id ?? user?.userId ?? user?.id;
  const [alerts, setAlerts] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [activeTab, setActiveTab] = useState('alerts');
  const [alertFilters, setAlertFilters] = useState({ status: 'active' });
  const [suggestionFilters, setSuggestionFilters] = useState({ status: 'pending' });

  const fetchAlerts = async () => {
    try {
      const params = new URLSearchParams(alertFilters).toString();
      const res = await api.get(`/inventory/advanced/alerts?${params}`);
      setAlerts(Array.isArray(res.data) ? res.data : (res.data?.alerts || []));
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchSuggestions = async () => {
    try {
      const params = new URLSearchParams(suggestionFilters).toString();
      const res = await api.get(`/inventory/advanced/purchase-suggestions?${params}`);
      setSuggestions(Array.isArray(res.data) ? res.data : (res.data?.suggestions || []));
    } catch (error) {
      console.error('Error:', error);
    }
  };

  useEffect(() => {
    fetchAlerts();
    fetchSuggestions();
  }, [alertFilters, suggestionFilters]);

  const handleAcknowledge = async (id) => {
    try {
      await api.post(`/inventory/advanced/alerts/${id}/acknowledge`, { user_id: uid });
      fetchAlerts();
    } catch (_error) {
      toast.error('Error acknowledging alert');
    }
  };

  const handleResolve = async (id) => {
    try {
      await api.post(`/inventory/advanced/alerts/${id}/resolve`, {});
      fetchAlerts();
    } catch (_error) {
      toast.error('Error resolving alert');
    }
  };

  const handleCreatePR = async (sug) => {
    try {
      await api.post('/procurement/purchase-requests', {
        item_id: sug.item_id,
        item_name: sug.item_name,
        quantity: parseFloat(sug.suggested_quantity) || 1,
        unit_of_measure: sug.unit_of_measure,
        required_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        notes: `Auto-generated from stock alert — ${sug.item_name}`,
        source: 'stock_suggestion',
        suggestion_id: sug.id,
      });
      // Mark suggestion as converted
      await api.post(`/inventory/advanced/purchase-suggestions/${sug.id}/reject`, {
        user_id: uid, reason: 'Converted to Purchase Request',
      }).catch(() => {});
      fetchSuggestions();
      setPage('PurchaseRequestDashboard');
    } catch (_error) {
      toast.error('Failed to create Purchase Request');
    }
  };

  const handleRejectSuggestion = async (id) => {
    const reason = prompt('Reason for rejection:');
    if (!reason) return;
    try {
      await api.post(`/inventory/advanced/purchase-suggestions/${id}/reject`, { user_id: uid, reason });
      fetchSuggestions();
    } catch (_error) {
      toast.error('Error rejecting suggestion');
    }
  };

  const getAlertIcon = (type) => {
    const icons = {
      low_stock: '⚠️',
      out_of_stock: '🚫',
      expiring_soon: '⏰',
      expired: '❌'
    };
    return icons[type] || '📦';
  };

  const getPriorityColor = (priority) => {
    const colors = {
      high: '#fee2e2',
      medium: '#fef3c7',
      low: '#dbeafe'
    };
    return colors[priority] || '#f3f4f6';
  };

  return (
    <div className="adv-inv-page">
      <div className="page-header">
        <div>
          <h1>Stock Alerts & Purchase Suggestions</h1>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${activeTab === 'alerts' ? 'active' : ''}`} onClick={() => setActiveTab('alerts')}>
          Stock Alerts ({alerts.length})
        </button>
        <button className={`tab ${activeTab === 'suggestions' ? 'active' : ''}`} onClick={() => setActiveTab('suggestions')}>
          Purchase Suggestions ({suggestions.length})
        </button>
      </div>

      {activeTab === 'alerts' && (
        <>
          <div className="filters-bar">
            <div className="filter-group">
              <label>Status:</label>
              <select value={alertFilters.status} onChange={(e) => setAlertFilters({ ...alertFilters, status: e.target.value })}>
                <option value="">All</option>
                <option value="active">Active</option>
                <option value="acknowledged">Acknowledged</option>
                <option value="resolved">Resolved</option>
              </select>
            </div>
            <div className="filter-group">
              <label>Type:</label>
              <select value={alertFilters.alert_type} onChange={(e) => setAlertFilters({ ...alertFilters, alert_type: e.target.value })}>
                <option value="">All Types</option>
                <option value="low_stock">Low Stock</option>
                <option value="out_of_stock">Out of Stock</option>
                <option value="expiring_soon">Expiring Soon</option>
                <option value="expired">Expired</option>
              </select>
            </div>
          </div>

          <div className="alerts-grid">
            {alerts.map(alert => (
              <div key={alert.id} className={`alert-card-full ${alert.alert_type}`}>
                <div className="alert-header">
                  <div className="alert-icon-large">{getAlertIcon(alert.alert_type)}</div>
                  <div className="alert-title">
                    <h3>{alert.item_name}</h3>
                    <p>{alert.item_code} - {alert.warehouse_name}</p>
                  </div>
                  <span className={`alert-status ${alert.status}`}>{alert.status}</span>
                </div>
                <div className="alert-body">
                  <div className="alert-metrics">
                    <div className="metric">
                      <span className="label">Current Stock:</span>
                      <span className="value">{alert.current_stock}</span>
                    </div>
                    <div className="metric">
                      <span className="label">Available:</span>
                      <span className="value">{alert.available_stock}</span>
                    </div>
                    <div className="metric">
                      <span className="label">Reserved:</span>
                      <span className="value">{alert.reserved_stock}</span>
                    </div>
                    <div className="metric">
                      <span className="label">Reorder Level:</span>
                      <span className="value">{alert.reorder_level}</span>
                    </div>
                  </div>
                  {alert.notes && <p className="alert-notes">{alert.notes}</p>}
                  <p className="alert-time">Generated: {new Date(alert.alert_date).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                </div>
                {alert.status === 'active' && (
                  <div className="alert-actions">
                    <button className="action-btn-sm" onClick={() => handleAcknowledge(alert.id)}>Acknowledge</button>
                    <button className="action-btn-sm success" onClick={() => handleResolve(alert.id)}>Resolve</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {activeTab === 'suggestions' && (
        <>
          <div className="filters-bar">
            <div className="filter-group">
              <label>Status:</label>
              <select value={suggestionFilters.status} onChange={(e) => setSuggestionFilters({ ...suggestionFilters, status: e.target.value })}>
                <option value="">All</option>
                <option value="pending">Pending</option>
                <option value="converted_to_pr">Converted to PR</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
            <div className="filter-group">
              <label>Priority:</label>
              <select value={suggestionFilters.priority} onChange={(e) => setSuggestionFilters({ ...suggestionFilters, priority: e.target.value })}>
                <option value="">All Priorities</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          <div className="suggestions-grid">
            {suggestions.map(sug => (
              <div key={sug.id} className="suggestion-card" style={{ borderLeft: `4px solid ${getPriorityColor(sug.priority)}` }}>
                <div className="suggestion-header">
                  <div>
                    <h3>{sug.item_name}</h3>
                    <p>{sug.item_code} - {sug.warehouse_name}</p>
                  </div>
                  <span className={`priority-badge ${sug.priority}`}>{sug.priority}</span>
                </div>
                <div className="suggestion-body">
                  <div className="stock-info">
                    <div className="info-item">
                      <span className="label">Current Stock:</span>
                      <span className="value">{parseFloat(sug.current_stock).toFixed(2)}</span>
                    </div>
                    <div className="info-item">
                      <span className="label">Available:</span>
                      <span className="value">{parseFloat(sug.available_stock).toFixed(2)}</span>
                    </div>
                    <div className="info-item">
                      <span className="label">Reserved:</span>
                      <span className="value">{parseFloat(sug.reserved_stock).toFixed(2)}</span>
                    </div>
                    <div className="info-item">
                      <span className="label">Reorder Level:</span>
                      <span className="value">{parseFloat(sug.reorder_level).toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="suggested-qty">
                    <strong>Suggested Quantity:</strong> {parseFloat(sug.suggested_quantity).toFixed(2)} {sug.unit_of_measure}
                  </div>
                  <p className="generated-date">Generated: {new Date(sug.generated_date).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                </div>
                {sug.status === 'pending' && (
                  <div className="suggestion-actions">
                    <button className="action-btn-sm success" onClick={() => handleCreatePR(sug)}>
                      Create PR
                    </button>
                    <button className="action-btn-sm danger" onClick={() => handleRejectSuggestion(sug.id)}>Reject</button>
                  </div>
                )}
                {sug.status === 'rejected' && sug.rejection_reason && (
                  <p className="rejection-reason">Rejected: {sug.rejection_reason}</p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default StockAlertsAndSuggestions;
