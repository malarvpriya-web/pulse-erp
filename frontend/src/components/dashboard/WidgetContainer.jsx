import React from 'react';
import './WidgetContainer.css';

const WidgetContainer = ({ children, size = { cols: 1 } }) => {
  return (
    <div 
      className="widget-container" 
      style={{ '--widget-cols': size.cols }}
    >
      {children}
    </div>
  );
};

export default WidgetContainer;
