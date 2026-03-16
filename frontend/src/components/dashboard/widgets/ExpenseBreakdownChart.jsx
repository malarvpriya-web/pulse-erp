import React, { useState, useEffect, useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { Maximize2, X } from 'lucide-react';
import { dashboardAPI } from '../../../services/api/dashboardAPI';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

const ExpenseBreakdownChart = ({ title = 'Expense Breakdown', data, refreshKey }) => {
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
      const response = await dashboardAPI.getExpenseBreakdown();
      setChartData(response || []);
    } catch (err) {
      setChartData([]);
    } finally {
      setLoading(false);
    }
  };

  const ChartContent = useMemo(() => ({ height }) => (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="45%"
          labelLine={false}
          outerRadius={height === 320 ? 100 : 80}
          fill="#8884d8"
          dataKey="value"
        >
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip 
          formatter={(value) => `₹${value.toLocaleString()}`}
          contentStyle={{ 
            backgroundColor: '#fff', 
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            fontSize: '13px',
            padding: '8px 12px'
          }}
        />
        <Legend 
          iconSize={10}
          wrapperStyle={{ fontSize: '12px' }}
        />
      </PieChart>
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

export default ExpenseBreakdownChart;
