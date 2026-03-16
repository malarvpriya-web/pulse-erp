import React, { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Maximize2, X } from 'lucide-react';
import { dashboardAPI } from '../../../services/api/dashboardAPI';

const RevenueTrendChart = ({ title = 'Revenue Trend', data, refreshKey }) => {
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (data) {
      setChartData(data);
      setLoading(false);
    } else {
      fetchData();
    }
  }, [data, refreshKey]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const response = await dashboardAPI.getRevenueTrend();
      setChartData(response || []);
    } catch (err) {
      setChartData([]);
    } finally {
      setLoading(false);
    }
  };

  const ChartContent = useMemo(() => ({ height }) => (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis 
          dataKey="month" 
          stroke="#6b7280"
          style={{ fontSize: '12px' }}
        />
        <YAxis 
          stroke="#6b7280"
          style={{ fontSize: '12px' }}
          tickFormatter={(value) => `₹${value / 1000}k`}
        />
        <Tooltip 
          formatter={(value) => [`₹${value.toLocaleString()}`, 'Revenue']}
          contentStyle={{ 
            backgroundColor: '#fff', 
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            fontSize: '13px',
            padding: '8px 12px'
          }}
        />
        <Line 
          type="monotone" 
          dataKey="revenue" 
          stroke="#3b82f6" 
          strokeWidth={3}
          dot={{ fill: '#3b82f6', r: 4 }}
          activeDot={{ r: 6 }}
        />
      </LineChart>
    </ResponsiveContainer>
  ), [chartData]);

  if (loading) {
    return (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 className="widget-title" style={{ margin: 0 }}>{title}</h3>
        </div>
        <div className="widget-loading">Loading chart...</div>
      </>
    );
  }

  if (!chartData || chartData.length === 0) {
    return (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 className="widget-title" style={{ margin: 0 }}>{title}</h3>
        </div>
        <div className="widget-empty">No data available</div>
      </>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 className="widget-title" style={{ margin: 0 }}>{title}</h3>
        <button
          onClick={() => setIsFullscreen(true)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '6px',
            display: 'flex',
            alignItems: 'center',
            color: '#6b7280',
            transition: 'color 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.color = '#3b82f6'}
          onMouseLeave={(e) => e.currentTarget.style.color = '#6b7280'}
          title="Fullscreen"
        >
          <Maximize2 size={16} />
        </button>
      </div>
      <div className="chart-container">
        <ChartContent height={320} />
      </div>

      {isFullscreen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }} onClick={() => setIsFullscreen(false)}>
          <div style={{
            background: 'white',
            borderRadius: '12px',
            width: '90vw',
            height: '80vh',
            padding: '24px',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column'
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#1f2937' }}>{title}</h2>
              <button
                onClick={() => setIsFullscreen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  color: '#6b7280'
                }}
                title="Close"
              >
                <X size={24} />
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ChartContent height="100%" />
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default RevenueTrendChart;
