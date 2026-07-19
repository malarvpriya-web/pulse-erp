import React, { useState, useEffect } from 'react';
import { UserPlus, CheckCircle, FileText, Target, IndianRupee, Clock } from 'lucide-react';
import { dashboardAPI } from '../../../services/api/dashboardAPI';
import './ActivityTimelineWidget.css';

const ACTIVITY_ICONS = {
  employee_joined: UserPlus,
  leave_approved: CheckCircle,
  po_approved: FileText,
  milestone_completed: Target,
  payment_processed: IndianRupee,
  default: Clock
};

const ACTIVITY_COLORS = {
  employee_joined: '#10b981',
  leave_approved: '#3b82f6',
  po_approved: '#8b5cf6',
  milestone_completed: '#f59e0b',
  payment_processed: '#10b981',
  default: '#6b7280'
};

const ActivityTimelineWidget = ({ title, apiEndpoint: _apiEndpoint, refreshKey }) => {
  const [data, setData] = useState([]);
  const [_loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

  const fetchData = async () => {
    try {

      setError(null);
      const response = await dashboardAPI.getRecentActivity();
      setData(response);
    } catch (err) {
      setError('Failed to load activity');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getTimeAgo = (timestamp) => {
    const now = new Date();
    const activityTime = new Date(timestamp);
    const diffMs = now - activityTime;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffHours < 1) return 'Just now';
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return '1 day ago';
    return `${diffDays} days ago`;
  };

  

  if (error) {
    return (
      <div className="activity-timeline-widget">
        <h3 className="widget-title">{title}</h3>
        <div className="widget-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="activity-timeline-widget">
      <div className="widget-header">
        <h3 className="widget-title">{title}</h3>
        <button className="view-all-btn">View All</button>
      </div>

      <div className="activity-timeline">
        {data.map((activity, index) => {
          const IconComponent = ACTIVITY_ICONS[activity.type] || ACTIVITY_ICONS.default;
          const iconColor = ACTIVITY_COLORS[activity.type] || ACTIVITY_COLORS.default;

          return (
            <div key={activity.id || index} className="activity-item">
              <div className="activity-icon" style={{ backgroundColor: `${iconColor}15` }}>
                <IconComponent size={20} color={iconColor} />
              </div>
              <div className="activity-content">
                <div className="activity-description">{activity.description}</div>
                <div className="activity-meta">
                  <span className="activity-user">{activity.user}</span>
                  <span className="activity-time">{getTimeAgo(activity.timestamp)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ActivityTimelineWidget;
