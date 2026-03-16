import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './AdvancedInventory.css';

const MaterialConsumption = () => {
  const navigate = useNavigate();
  const [consumption, setConsumption] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [activeTab, setActiveTab] = useState('by-project');

  useEffect(() => {
    fetchConsumption();
    fetchAllocations();
  }, []);

  const fetchConsumption = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/inventory/advanced/material-consumption', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setConsumption(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchAllocations = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/inventory/advanced/allocations', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setAllocations(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const groupByType = () => {
    const grouped = {};
    allocations.forEach(alloc => {
      if (!grouped[alloc.allocation_type]) {
        grouped[alloc.allocation_type] = [];
      }
      grouped[alloc.allocation_type].push(alloc);
    });
    return grouped;
  };

  const groupedAllocations = groupByType();

  return (
    <div className="adv-inv-page">
      <div className="page-header">
        <div>
          <button className="back-btn" onClick={() => navigate('/inventory/advanced')}>← Back</button>
          <h1>Material Consumption Tracking</h1>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${activeTab === 'by-project' ? 'active' : ''}`} onClick={() => setActiveTab('by-project')}>
          By Project
        </button>
        <button className={`tab ${activeTab === 'by-type' ? 'active' : ''}`} onClick={() => setActiveTab('by-type')}>
          By Type
        </button>
        <button className={`tab ${activeTab === 'all-allocations' ? 'active' : ''}`} onClick={() => setActiveTab('all-allocations')}>
          All Allocations
        </button>
      </div>

      {activeTab === 'by-project' && (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project ID</th>
                <th>Item Code</th>
                <th>Item Name</th>
                <th>Unit</th>
                <th>Total Consumed</th>
                <th>Avg Rate</th>
                <th>Total Value</th>
                <th>Transactions</th>
              </tr>
            </thead>
            <tbody>
              {consumption.map((item, idx) => (
                <tr key={idx}>
                  <td><strong>{item.project_id}</strong></td>
                  <td>{item.item_code}</td>
                  <td>{item.item_name}</td>
                  <td>{item.unit_of_measure}</td>
                  <td>{parseFloat(item.total_consumed).toFixed(2)}</td>
                  <td>${parseFloat(item.avg_rate).toFixed(2)}</td>
                  <td><strong>${parseFloat(item.total_value).toFixed(2)}</strong></td>
                  <td>{item.transaction_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'by-type' && (
        <div className="type-sections">
          {Object.keys(groupedAllocations).map(type => (
            <div key={type} className="type-section">
              <h3>{type.replace('_', ' ').toUpperCase()}</h3>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Warehouse</th>
                      <th>Batch</th>
                      <th>Reference</th>
                      <th>Quantity</th>
                      <th>Rate</th>
                      <th>Value</th>
                      <th>Date</th>
                      <th>Purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupedAllocations[type].map(alloc => (
                      <tr key={alloc.id}>
                        <td>{alloc.item_name} ({alloc.item_code})</td>
                        <td>{alloc.warehouse_name}</td>
                        <td>{alloc.batch_number || 'N/A'}</td>
                        <td>{alloc.reference_id}</td>
                        <td>{parseFloat(alloc.quantity).toFixed(2)}</td>
                        <td>${parseFloat(alloc.rate || 0).toFixed(2)}</td>
                        <td>${(parseFloat(alloc.quantity) * parseFloat(alloc.rate || 0)).toFixed(2)}</td>
                        <td>{new Date(alloc.allocation_date).toLocaleDateString()}</td>
                        <td>{alloc.purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'all-allocations' && (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Item</th>
                <th>Warehouse</th>
                <th>Batch</th>
                <th>Type</th>
                <th>Reference</th>
                <th>Quantity</th>
                <th>Rate</th>
                <th>Value</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {allocations.map(alloc => (
                <tr key={alloc.id}>
                  <td>{new Date(alloc.allocation_date).toLocaleDateString()}</td>
                  <td>{alloc.item_name} ({alloc.item_code})</td>
                  <td>{alloc.warehouse_name}</td>
                  <td>{alloc.batch_number || 'N/A'}</td>
                  <td><span className="type-badge">{alloc.allocation_type}</span></td>
                  <td>{alloc.reference_id}</td>
                  <td>{parseFloat(alloc.quantity).toFixed(2)}</td>
                  <td>${parseFloat(alloc.rate || 0).toFixed(2)}</td>
                  <td><strong>${(parseFloat(alloc.quantity) * parseFloat(alloc.rate || 0)).toFixed(2)}</strong></td>
                  <td>{alloc.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default MaterialConsumption;
