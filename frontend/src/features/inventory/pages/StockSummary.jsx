import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import './StockSummary.css';

export default function StockSummary() {
  const [stock, setStock] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [filters, setFilters] = useState({ warehouse_id: '', item_type: '' });
  const [showLowStock, setShowLowStock] = useState(false);

  useEffect(() => {
    fetchStock();
    fetchLowStock();
    fetchWarehouses();
  }, [filters]);

  const fetchStock = async () => {
    try {
      const response = await api.get('/inventory/stock/summary', { params: filters });
      setStock(response.data);
    } catch (error) {
      console.error('Error fetching stock:', error);
    }
  };

  const fetchLowStock = async () => {
    try {
      const response = await api.get('/inventory/stock/low-stock');
      setLowStock(response.data);
    } catch (error) {
      console.error('Error fetching low stock:', error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const response = await api.get('/inventory/warehouses');
      setWarehouses(response.data);
    } catch (error) {
      console.error('Error fetching warehouses:', error);
    }
  };

  const getTotalValue = () => {
    return stock.reduce((sum, item) => sum + (parseFloat(item.balance) * parseFloat(item.avg_rate)), 0);
  };

  return (
    <div className="stock-page">
      <div className="page-header">
        <h1>Stock Summary</h1>
        <button className="primary-btn" onClick={() => setShowLowStock(!showLowStock)}>
          {showLowStock ? 'View All Stock' : `Low Stock Alerts (${lowStock.length})`}
        </button>
      </div>

      {!showLowStock && (
        <>
          <div className="filters">
            <select value={filters.warehouse_id} onChange={(e) => setFilters({ ...filters, warehouse_id: e.target.value })}>
              <option value="">All Warehouses</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.warehouse_name}</option>)}
            </select>
            <select value={filters.item_type} onChange={(e) => setFilters({ ...filters, item_type: e.target.value })}>
              <option value="">All Types</option>
              <option value="raw_material">Raw Material</option>
              <option value="finished_goods">Finished Goods</option>
              <option value="consumable">Consumable</option>
              <option value="spare">Spare</option>
            </select>
          </div>

          <div className="summary-cards">
            <div className="summary-card">
              <h3>Total Items</h3>
              <div className="card-value">{stock.length}</div>
            </div>
            <div className="summary-card">
              <h3>Total Value</h3>
              <div className="card-value">${getTotalValue().toLocaleString()}</div>
            </div>
            <div className="summary-card alert">
              <h3>Low Stock Items</h3>
              <div className="card-value">{lowStock.length}</div>
            </div>
          </div>

          <div className="widget">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item Code</th>
                  <th>Item Name</th>
                  <th>Warehouse</th>
                  <th>Balance</th>
                  <th>UOM</th>
                  <th>Avg Rate</th>
                  <th>Value</th>
                  <th>Reorder Level</th>
                </tr>
              </thead>
              <tbody>
                {stock.map((item, index) => (
                  <tr key={index} className={parseFloat(item.balance) <= parseFloat(item.reorder_level) ? 'low-stock-row' : ''}>
                    <td>{item.item_code}</td>
                    <td>{item.item_name}</td>
                    <td>{item.warehouse_name}</td>
                    <td>{parseFloat(item.balance).toFixed(2)}</td>
                    <td>{item.unit_of_measure}</td>
                    <td>${parseFloat(item.avg_rate).toFixed(2)}</td>
                    <td>${(parseFloat(item.balance) * parseFloat(item.avg_rate)).toFixed(2)}</td>
                    <td>{parseFloat(item.reorder_level).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showLowStock && (
        <div className="widget">
          <h2>Low Stock Alerts</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Item Name</th>
                <th>Warehouse</th>
                <th>Current Balance</th>
                <th>Reorder Level</th>
                <th>Shortage</th>
              </tr>
            </thead>
            <tbody>
              {lowStock.map((item, index) => (
                <tr key={index} className="low-stock-row">
                  <td>{item.item_code}</td>
                  <td>{item.item_name}</td>
                  <td>{item.warehouse_name}</td>
                  <td>{parseFloat(item.balance).toFixed(2)}</td>
                  <td>{parseFloat(item.reorder_level).toFixed(2)}</td>
                  <td className="shortage">{(parseFloat(item.reorder_level) - parseFloat(item.balance)).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
