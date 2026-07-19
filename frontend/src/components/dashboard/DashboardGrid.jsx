import React from 'react';
import './DashboardGrid.css';

const DashboardGrid = ({ children, columns = 12 }) => {
  return (
    <div className="dashboard-grid" style={{ '--grid-columns': columns }}>
      {children}
    </div>
  );
};

export default DashboardGrid;
