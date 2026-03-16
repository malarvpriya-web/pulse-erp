import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';
import './PurchaseOrderManagement.css';

const PurchaseOrderManagement = () => {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    try {
      const res = await api.get('/procurement/purchase-orders');
      setOrders(res.data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching orders:', error);
      // Fallback mock data for demonstration if API fails
      setOrders([
        { id: 1, po_number: 'PO-2024-001', vendor_name: 'Acme Corp', order_date: '2024-03-01', total_amount: 15000.00, status: 'approved' },
        { id: 2, po_number: 'PO-2024-002', vendor_name: 'Global Supplies', order_date: '2024-03-05', total_amount: 4500.50, status: 'pending' },
        { id: 3, po_number: 'PO-2024-003', vendor_name: 'Tech Solutions', order_date: '2024-03-10', total_amount: 8200.00, status: 'draft' },
      ]);
      setLoading(false);
    }
  };

  const getStatusClass = (status) => {
    const map = {
      approved: 'status-approved',
      pending: 'status-pending',
      draft: 'status-draft',
      rejected: 'status-rejected'
    };
    return map[status?.toLowerCase()] || '';
  };

  return (
    <div className="po-page">
      <div className="po-header">
        <h1>Purchase Order Management</h1>
        <button className="primary-btn">+ Create PO</button>
      </div>

      <div className="po-table-container">
        <table className="po-table">
          <thead>
            <tr>
              <th>PO Number</th>
              <th>Vendor</th>
              <th>Date</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(order => (
              <tr key={order.id}>
                <td><strong>{order.po_number}</strong></td>
                <td>{order.vendor_name}</td>
                <td>{new Date(order.order_date).toLocaleDateString()}</td>
                <td>₹{parseFloat(order.total_amount).toLocaleString()}</td>
                <td><span className={`status-badge ${getStatusClass(order.status)}`}>{order.status}</span></td>
                <td>
                  <button className="action-btn">View</button>
                </td>
              </tr>
            ))}
            {orders.length === 0 && !loading && (
              <tr>
                <td colSpan="6" style={{ textAlign: 'center', padding: '20px' }}>No purchase orders found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default PurchaseOrderManagement;