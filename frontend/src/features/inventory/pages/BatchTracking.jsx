import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';
import './AdvancedInventory.css';
import { useToast } from '@/context/ToastContext';

const BatchTracking = ({ setPage }) => {
  const toast = useToast();
  const [batches, setBatches] = useState([]);
  const [items, setItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [filters, setFilters] = useState({ status: 'active' });
  const [formData, setFormData] = useState({
    item_id: '',
    warehouse_id: '',
    batch_number: '',
    received_date: new Date().toISOString().split('T')[0],
    expiry_date: '',
    supplier_id: '',
    quantity_received: '',
    rate: ''
  });

  const fetchBatches = async () => {
    try {
      const params = new URLSearchParams(filters).toString();
      const res = await api.get(`/inventory/advanced/batches?${params}`);
      setBatches(Array.isArray(res.data) ? res.data : (res.data?.batches || []));
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchItems = async () => {
    try {
      const res = await api.get('/inventory/items');
      setItems(Array.isArray(res.data) ? res.data : (res.data?.items || []));
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const res = await api.get('/inventory/warehouses');
      setWarehouses(Array.isArray(res.data) ? res.data : (res.data?.warehouses || []));
    } catch (error) {
      console.error('Error:', error);
    }
  };

  useEffect(() => {
    fetchBatches();
    fetchItems();
    fetchWarehouses();
  }, [filters]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/inventory/advanced/batches', formData);
      toast.success('Batch created successfully');
      setShowForm(false);
      resetForm();
      fetchBatches();
    } catch (_error) {
      toast.error('Error creating batch');
    }
  };

  const resetForm = () => {
    setFormData({
      item_id: '',
      warehouse_id: '',
      batch_number: '',
      received_date: new Date().toISOString().split('T')[0],
      expiry_date: '',
      supplier_id: '',
      quantity_received: '',
      rate: ''
    });
  };

  const getStatusColor = (status) => {
    const colors = { active: '#dcfce7', expired: '#fee2e2', depleted: '#f3f4f6' };
    return colors[status] || '#f3f4f6';
  };

  const getExpiryStatus = (expiryDate) => {
    if (!expiryDate) return null;
    const days = Math.ceil((new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24));
    if (days < 0) return <span className="expiry-badge expired">Expired</span>;
    if (days <= 30) return <span className="expiry-badge warning">Expires in {days} days</span>;
    return <span className="expiry-badge ok">{days} days left</span>;
  };

  return (
    <div className="adv-inv-page">
      <div className="page-header">
        <div>
          <h1>Batch Tracking</h1>
        </div>
        <button className="primary-btn" onClick={() => setShowForm(true)}>+ New Batch</button>
      </div>

      {showForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Create New Batch</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Item *</label>
                  <select value={formData.item_id} onChange={(e) => setFormData({ ...formData, item_id: e.target.value })} required>
                    <option value="">Select Item</option>
                    {items.map(item => (
                      <option key={item.id} value={item.id}>{item.item_name} ({item.item_code})</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Warehouse *</label>
                  <select value={formData.warehouse_id} onChange={(e) => setFormData({ ...formData, warehouse_id: e.target.value })} required>
                    <option value="">Select Warehouse</option>
                    {warehouses.map(wh => (
                      <option key={wh.id} value={wh.id}>{wh.warehouse_name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Batch Number *</label>
                  <input type="text" value={formData.batch_number} onChange={(e) => setFormData({ ...formData, batch_number: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Received Date *</label>
                  <input type="date" value={formData.received_date} onChange={(e) => setFormData({ ...formData, received_date: e.target.value })} required />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Expiry Date</label>
                  <input type="date" value={formData.expiry_date} onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Quantity Received *</label>
                  <input type="number" step="0.01" value={formData.quantity_received} onChange={(e) => setFormData({ ...formData, quantity_received: e.target.value })} required />
                </div>
              </div>

              <div className="form-group">
                <label>Rate *</label>
                <input type="number" step="0.01" value={formData.rate} onChange={(e) => setFormData({ ...formData, rate: e.target.value })} required />
              </div>

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => { setShowForm(false); resetForm(); }}>Cancel</button>
                <button type="submit" className="submit-btn">Create Batch</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="filters-bar">
        <div className="filter-group">
          <label>Status:</label>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="depleted">Depleted</option>
          </select>
        </div>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Batch Number</th>
              <th>Item</th>
              <th>Warehouse</th>
              <th>Received Date</th>
              <th>Age (Days)</th>
              <th>Expiry</th>
              <th>Supplier</th>
              <th>Received</th>
              <th>Available</th>
              <th>Reserved</th>
              <th>Consumed</th>
              <th>Rate</th>
              <th>Value</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {batches.map(batch => (
              <tr key={batch.batch_id}>
                <td><strong>{batch.batch_number}</strong></td>
                <td>{batch.item_name} ({batch.item_code})</td>
                <td>{batch.warehouse_name}</td>
                <td>{new Date(batch.received_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                <td>{batch.age_days}</td>
                <td>{batch.expiry_date ? new Date(batch.expiry_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'N/A'}<br/>{getExpiryStatus(batch.expiry_date)}</td>
                <td>{batch.supplier_name || 'N/A'}</td>
                <td>{parseFloat(batch.quantity_received).toFixed(2)}</td>
                <td>{parseFloat(batch.quantity_available).toFixed(2)}</td>
                <td>{parseFloat(batch.quantity_reserved).toFixed(2)}</td>
                <td>{parseFloat(batch.quantity_consumed).toFixed(2)}</td>
                <td>₹{parseFloat(batch.rate).toFixed(2)}</td>
                <td>₹{parseFloat(batch.stock_value).toFixed(2)}</td>
                <td><span className="status-badge" style={{ background: getStatusColor(batch.status) }}>{batch.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default BatchTracking;
