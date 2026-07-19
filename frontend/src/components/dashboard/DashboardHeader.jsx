import React from 'react';
import { RefreshCw, Download } from 'lucide-react';
import './DashboardHeader.css';

const DashboardHeader = ({ onRefresh, onFilterChange, currentFilter }) => {
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  const formatDate = () => {
    const date = new Date();
    const day = String(date.getDate()).padStart(2, '0');
    const month = date.toLocaleString('en-US', { month: 'long' });
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
  };

  const filters = [
    { value: '7days', label: 'Last 7 Days' },
    { value: '30days', label: 'Last 30 Days' },
    { value: '90days', label: 'Last 90 Days' },
    { value: 'year', label: 'This Year' }
  ];

  return (
    <div className="dashboard-header">
      <div className="header-left">
        <h1 className="dashboard-title">{getGreeting()}</h1>
        <p className="dashboard-date">Today: {formatDate()}</p>
      </div>
      
      <div className="header-right">
        <select 
          className="filter-select"
          value={currentFilter}
          onChange={(e) => onFilterChange(e.target.value)}
        >
          {filters.map(filter => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
        
        <button className="header-btn" onClick={onRefresh} title="Refresh Dashboard">
          <RefreshCw size={18} />
          <span>Refresh</span>
        </button>
        
        <button className="header-btn" title="Export Report">
          <Download size={18} />
          <span>Export</span>
        </button>
      </div>
    </div>
  );
};

export default DashboardHeader;
