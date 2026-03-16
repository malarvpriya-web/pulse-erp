import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { getWidget } from './widgetRegistry';
import { getDefaultLayout, getSavedLayout, saveLayout, resetLayout } from '../../config/dashboardLayouts';
import { dashboardAPI } from '../../services/api/dashboardAPI';
import InsightBar from './InsightBar';
import KPISummary from './KPISummary';
import './DashboardEngine.css';

// Safe fallback grid — works even if react-grid-layout is missing
const FallbackGrid = ({ children }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', padding: '18px 0' }}>
    {children}
  </div>
);

let ReactGridLayout = FallbackGrid;
let layoutCSSLoaded = false;

// Dynamically load react-grid-layout only if available
import('react-grid-layout').then(({ default: RGL, WidthProvider }) => {
  ReactGridLayout = WidthProvider(RGL);
  if (!layoutCSSLoaded) {
    import('react-grid-layout/css/styles.css');
    import('react-resizable/css/styles.css');
    layoutCSSLoaded = true;
  }
}).catch(() => {
  console.warn('react-grid-layout not found, using fallback layout');
});

class WidgetErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(e, i) { console.error('Widget error:', e, i); }
  render() {
    if (this.state.hasError)
      return <div className="widget-error-boundary"><p>Widget failed to load</p><button onClick={() => this.setState({ hasError: false })}>Retry</button></div>;
    return this.props.children;
  }
}

const DashboardEngine = ({ role }) => {
  const [layout, setLayout]               = useState([]);
  const [dashboardData, setDashboardData] = useState({});
  const [insightData, setInsightData]     = useState({});
  const [loading, setLoading]             = useState(true);
  const [refreshKey, setRefreshKey]       = useState(0);
  const [lastRefresh, setLastRefresh]     = useState(new Date());
  const [isDragging, setIsDragging]       = useState(false);

  const fetchDashboardData = useCallback(async () => {
    try {
      const data     = await dashboardAPI.getDashboardData();
      const insights = await dashboardAPI.getDashboardInsights();
      setDashboardData(data && typeof data === 'object' ? data : {});
      setInsightData(insights && typeof insights === 'object' ? insights : {});
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    }
  }, []);

  const initializeDashboard = useCallback(async () => {
    try {
      setLoading(true);
      const saved = getSavedLayout(role);
      setLayout(saved || getDefaultLayout(role));
      await fetchDashboardData();
    } catch (err) {
      setLayout(getDefaultLayout(role));
    } finally {
      setLoading(false);
    }
  }, [role, fetchDashboardData]);

  useEffect(() => { initializeDashboard(); }, [initializeDashboard]);

  useEffect(() => {
    const ms = Number(import.meta.env.VITE_DASHBOARD_REFRESH_INTERVAL) || 300000;
    const interval = setInterval(fetchDashboardData, ms);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  const handleRefresh      = useCallback(() => { setRefreshKey(k => k + 1); fetchDashboardData(); }, [fetchDashboardData]);
  const handleLayoutChange = useCallback((nl) => { if (!isDragging) return; setLayout(nl); saveLayout(role, nl); }, [role, isDragging]);
  const handleResetLayout  = useCallback(() => { setLayout(resetLayout(role)); }, [role]);

  const formatTime = (d) => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const getGreeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
  const formatDate  = () => new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'long', year: 'numeric' });

  const renderWidget = useCallback((layoutItem) => {
    const cfg = getWidget(layoutItem.i);
    if (!cfg) return (
      <div key={layoutItem.i} className="dashboard-widget-container">
        <div className="widget-not-found"><p>Widget not found: {layoutItem.i}</p></div>
      </div>
    );
    const WidgetComponent = cfg.component;
    return (
      <div key={layoutItem.i} className="dashboard-widget-container">
        <div className="widget-drag-handle"><span className="widget-drag-icon">⋮⋮</span></div>
        <WidgetErrorBoundary>
          <WidgetComponent title={cfg.title} data={dashboardData[layoutItem.i] || null} refreshKey={refreshKey} />
        </WidgetErrorBoundary>
      </div>
    );
  }, [dashboardData, refreshKey]);

  if (loading) return (
    <div className="dashboard-loading">
      <div className="loading-spinner"></div>
      <p>Loading dashboard...</p>
    </div>
  );

  return (
    <div className="dashboard-engine">
      <div className="dashboard-header">
        <div className="header-left">
          <h1 className="dashboard-greeting">{getGreeting()}</h1>
          <p className="dashboard-date">Today: {formatDate()}</p>
        </div>
        <div className="header-right">
          <div className="last-refresh">Last updated: {formatTime(lastRefresh)}</div>
          <button className="dashboard-btn" onClick={handleResetLayout}><RotateCcw size={16} /><span>Reset</span></button>
          <button className="dashboard-btn primary" onClick={handleRefresh}><RefreshCw size={16} /><span>Refresh</span></button>
        </div>
      </div>

      <InsightBar data={insightData} />
      <KPISummary data={dashboardData?.kpis} />

      <ReactGridLayout
        className="dashboard-grid-layout"
        layout={layout}
        cols={12}
        rowHeight={60}
        isDraggable={true}
        isResizable={true}
        draggableHandle=".widget-drag-handle"
        onLayoutChange={handleLayoutChange}
        onDragStart={() => setIsDragging(true)}
        onDragStop={() => setIsDragging(false)}
        onResizeStart={() => setIsDragging(true)}
        onResizeStop={() => setIsDragging(false)}
        margin={[18, 18]}
        containerPadding={[0, 0]}
      >
        {layout.map(renderWidget)}
      </ReactGridLayout>

      {layout.length === 0 && <div className="dashboard-empty"><p>No widgets available for your role.</p></div>}
    </div>
  );
};

export default DashboardEngine;