import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './AdvancedInventory.css';

const StockReservations = () => {
  const navigate = useNavigate();
  const [reservations, setReservations] = useState([]);
  const [items, setItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [filters, setFilters] = useState({ status: 'active' });
  const [formData, setFormData] = useState({
    item_id: '',
    warehouse_id: '',
    reservation_type: 'project',
    reference_type: 'project_id',
    reference_id: '',
    reference_number: '',
    quantity_reserved: '',
    reserved_date: new Date().toISOString().split('T')[0],
    expiry_date: '',
    notes: ''
  });

  useEffect(() => {
    fetchReservations();
    fetchItems();
    fetchWarehouses();
  }, [filters]);

  const fetchReservations = async () => {
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams(filters).toString();
      const res = await axios.get(`http://localhost:5000/api/inventory/advanced/reservations?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setReservations(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchItems = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/inventory/items', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setItems(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/inventory/warehouses', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setWarehouses(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      await axios.post('http://localhost:5000/api/inventory/advanced/reservations', 
        { ...formData, reserved_by: currentUser.id },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      alert('Reservation created successfully');
      setShowForm(false);
      resetForm();
      fetchReservations();
    } catch (error) {
      alert('Error creating reservation');
    }
  };

  const handleCancel = async (id) => {
    if (!window.confirm('Cancel this reservation?')) return;
    try {
      const token = localStorage.getItem('token');
      await axios.post(`http://localhost:5000/api/inventory/advanced/reservations/${id}/cancel`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      alert('Reservation cancelled');
      fetchReservations();
    } catch (error) {
      alert('Error cancelling reservation');
    }
  };

  const resetForm = () => {
    setFormData({
      item_id: '',
      warehouse_id: '',
      reservation_type: 'project',
      reference_type: 'project_id',
      reference_id: '',
      reference_number: '',
      quantity_reserved: '',
      reserved_date: new Date().toISOString().split('T')[0],
      expiry_date: '',
      notes: ''
    });
  };

  const getStatusColor = (status) => {
    const colors = {
      active: '#dbeafe',
      partially_consumed: '#fef3c7',
      fully_consumed: '#dcfce7',
      cancelled: '#fee2e2',
      expired: '#f3f4f6'
    };
    return colors[status] || '#f3f4f6';
  };

  return (
    <div className="adv-inv-page">
      <div className="page-header">
        <div>
          <button className="back-btn" onClick={() => navigate('/inventory/advanced')}>← Back</button>
          <h1>Stock Reservations</h1>
        </div>
        <button className="primary-btn" onClick={() => setShowForm(true)}>+ New Reservation</button>
      </div>

      {showForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Create Stock Reservation</h2>
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
                  <label>Reservation Type *</label>
                  <select value={formData.reservation_type} onChange={(e) => setFormData({ ...formData, reservation_type: e.target.value })} required>
                    <option value="project">Project</option>
                    <option value="sales_order">Sales Order</option>
                    <option value="production_order">Production Order</option>
                    <option value="service">Service</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Reference Number *</label>
                  <input type="text" value={formData.reference_number} onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })} required />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Quantity Reserved *</label>
                  <input type="number" step="0.01" value={formData.quantity_reserved} onChange={(e) => setFormData({ ...formData, quantity_reserved: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Reserved Date *</label>
                  <input type="date" value={formData.reserved_date} onChange={(e) => setFormData({ ...formData, reserved_date: e.target.value })} required />
                </div>
              </div>

              <div className="form-group">
                <label>Expiry Date</label>
                <input type="date" value={formData.expiry_date} onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })} />
              </div>

              <div className="form-group">
                <label>Notes</label>
                <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} rows="3" />
              </div>

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => { setShowForm(false); resetForm(); }}>Cancel</button>
                <button type="submit" className="submit-btn">Create Reservation</button>
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
            <option value="partially_consumed">Partially Consumed</option>
            <option value="fully_consumed">Fully Consumed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Type:</label>
          <select value={filters.reference_type} onChange={(e) => setFilters({ ...filters, reference_type: e.target.value })}>
            <option value="">All Types</option>
            <option value="project_id">Project</option>
            <option value="sales_order_id">Sales Order</option>
            <option value="production_order_id">Production</option>
            <option value="service_ticket_id">Service</option>
          </select>
        </div>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Warehouse</th>
              <th>Type</th>
              <th>Reference</th>
              <th>Batch</th>
              <th>Reserved</th>
              <th>Consumed</th>
              <th>Remaining</th>
              <th>Reserved Date</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {reservations.map(res => (
              <tr key={res.id}>
                <td>{res.item_name} ({res.item_code})</td>
                <td>{res.warehouse_name}</td>
                <td><span className="type-badge">{res.reservation_type}</span></td>
                <td>{res.reference_number}</td>
                <td>{res.batch_number || 'N/A'}</td>
                <td>{parseFloat(res.quantity_reserved).toFixed(2)}</td>
                <td>{parseFloat(res.quantity_consumed).toFixed(2)}</td>
                <td>{parseFloat(res.quantity_remaining).toFixed(2)}</td>
                <td>{new Date(res.reserved_date).toLocaleDateString()}</td>
                <td><span className="status-badge" style={{ background: getStatusColor(res.status) }}>{res.status.replace('_', ' ')}</span></td>
                <td>
                  {res.status === 'active' && (
                    <button className="action-btn-sm danger" onClick={() => handleCancel(res.id)}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default StockReservations;
