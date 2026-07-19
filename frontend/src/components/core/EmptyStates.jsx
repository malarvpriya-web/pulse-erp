import {
  Inbox, Users, FileText, Leaf, Tag, Folder, Search,
  BarChart2, CheckCircle, Clock, User, Bell, Lightbulb,
} from 'lucide-react';

const EMPTY_CONFIGS = {
  default:     { Icon: Inbox,       title: 'No data found',           sub: 'Nothing to display yet' },
  employees:   { Icon: Users,       title: 'No employees found',      sub: 'Add your first employee to get started' },
  invoices:    { Icon: FileText,    title: 'No invoices yet',         sub: 'Create your first invoice' },
  leaves:      { Icon: Leaf,        title: 'No leave requests',       sub: 'All leave requests will appear here' },
  tickets:     { Icon: Tag,         title: 'No tickets',              sub: 'All support tickets appear here' },
  projects:    { Icon: Folder,      title: 'No projects',             sub: 'Create your first project' },
  search:      { Icon: Search,      title: 'No results found',        sub: 'Try adjusting your search or filters' },
  analytics:   { Icon: BarChart2,   title: 'No data available',       sub: 'Analytics will appear once data is recorded' },
  approvals:   { Icon: CheckCircle, title: 'All caught up!',          sub: 'No pending approvals at this time' },
  timesheets:  { Icon: Clock,       title: 'No timesheets',           sub: 'Submit your weekly timesheet to see it here' },
  candidates:  { Icon: User,        title: 'No candidates',           sub: 'Add candidates to the pipeline' },
  alerts:      { Icon: Bell,        title: 'No active alerts',        sub: 'All clear — no alerts to show' },
  recommendations: { Icon: Lightbulb, title: 'No recommendations',   sub: 'Great job! No actions required right now' },
};

export function EmptyState({ type = 'default', title, subtitle, action, compact = false }) {
  const cfg = EMPTY_CONFIGS[type] || EMPTY_CONFIGS.default;
  const { Icon } = cfg;
  const iconSize = compact ? 28 : 48;

  return (
    <div style={{
      textAlign: 'center',
      padding: compact ? '20px 16px' : '60px 24px',
      color: '#9ca3af',
    }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center' }}>
        <Icon size={iconSize} color="#d1d5db" strokeWidth={1.5} />
      </div>
      <div style={{ fontSize: compact ? 14 : 15, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
        {title || cfg.title}
      </div>
      <div style={{ fontSize: compact ? 12 : 13, color: '#9ca3af' }}>
        {subtitle || cfg.sub}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          style={{
            marginTop: 16,
            padding: '8px 18px',
            background: '#6366f1',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export default EmptyState;
