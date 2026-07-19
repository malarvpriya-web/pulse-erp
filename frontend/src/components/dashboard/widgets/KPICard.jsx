import React, { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import * as Icons from 'lucide-react';
import { dashboardAPI } from '../../../services/api/dashboardAPI';
import './KPICard.css';

const KPICard = ({ title, icon, color, apiEndpoint: _apiEndpoint, dataKey, refreshKey }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const IconComponent = Icons[icon] || Icons.Activity;

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

  const fetchData = async () => {
    try {

      setError(null);
      const response = await dashboardAPI.getKPIs();
      setData(response[dataKey]);
    } catch (err) {
      setError('Failed to load data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };


  if (error) {
    return (
      <div className="kpi-card" style={{ '--kpi-color': color }}>
        <div className="kpi-error">{error}</div>
      </div>
    );
  }

  const { value, trend, percentage } = data || {};
  const isPositive = trend === 'up';

  return (
    <div className="kpi-card" style={{ '--kpi-color': color }}>
      <div className="kpi-header">
        <div className="kpi-icon" style={{ backgroundColor: `${color}15` }}>
          <IconComponent size={24} color={color} />
        </div>
        <span className="kpi-title">{title}</span>
      </div>
      
      <div className="kpi-value">{value}</div>
      
      {trend && (
        <div className={`kpi-trend ${isPositive ? 'positive' : 'negative'}`}>
          {isPositive ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          <span>{percentage}%</span>
        </div>
      )}
    </div>
  );
};

export default KPICard;
