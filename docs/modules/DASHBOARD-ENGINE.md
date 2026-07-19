# Enterprise Dashboard Engine

A scalable, plugin-based dashboard system for the Pulse ERP that supports drag-and-drop widgets, automatic layout saving, and role-based dashboards.

## Architecture Overview

The dashboard system consists of 5 core components:

### 1. Dashboard Engine (`DashboardEngine.jsx`)
The central component that manages widget layout and rendering.

**Features:**
- Drag-and-drop widget positioning using `react-grid-layout`
- Automatic layout persistence to localStorage
- Role-based widget loading
- Auto-refresh every 5 minutes
- Manual refresh capability
- Layout reset functionality
- Resilient error handling

### 2. Widget Registry (`widgetRegistry.js`)
Centralized registry for all available widgets.

**Widget Metadata:**
```javascript
{
  id: 'widgetId',
  title: 'Widget Title',
  component: WidgetComponent,
  defaultSize: { w: 8, h: 3 },
  minSize: { w: 4, h: 2 },
  dataSource: '/api/dashboard/data',
  category: 'financial',
  roles: ['super_admin', 'admin']
}
```

### 3. Dashboard Layouts (`dashboardLayouts.js`)
Role-based default layouts and layout management.

**Functions:**
- `getDefaultLayout(role)` - Get default layout for role
- `getSavedLayout(role)` - Load saved layout from localStorage
- `saveLayout(role, layout)` - Save layout to localStorage
- `resetLayout(role)` - Reset to default layout

### 4. Insight Bar (`InsightBar.jsx`)
Top-level metrics bar showing critical business indicators.

**Displays:**
- Revenue Today
- Invoices Due
- Open Tickets
- Stock Alerts

### 5. KPI Summary (`KPISummary.jsx`)
Executive KPI snapshot with trend indicators.

**Shows:**
- Total Revenue (with trend)
- Active Projects (with trend)
- Employees (with trend)
- Pending Approvals (with trend)

## Dashboard Hierarchy

```
┌─────────────────────────────────────────────┐
│           INSIGHT BAR                       │
│  Revenue | Invoices | Tickets | Alerts     │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│           KPI SUMMARY                       │
│  Revenue | Projects | Employees | Approvals│
└─────────────────────────────────────────────┘

┌──────────────────────┬──────────────────────┐
│  Revenue Trend (8)   │ Expense Breakdown(4) │
│                      │                      │
└──────────────────────┴──────────────────────┘

┌─────┬─────┬─────┬─────┐
│Cash │Work │Ops  │Alert│
│ (3) │(3)  │(3)  │ (3) │
└─────┴─────┴─────┴─────┘

┌──────────────────────┬──────────────────────┐
│  Sales Pipeline (8)  │ Approvals Queue (4)  │
│                      │                      │
└──────────────────────┴──────────────────────┘

┌─────────────────────────────────────────────┐
│         Recent Activity (12)                │
│                                             │
└─────────────────────────────────────────────┘
```

## Adding New Widgets

### Step 1: Create Widget Component

```javascript
// src/components/dashboard/widgets/MyWidget.jsx
import React from 'react';

const MyWidget = ({ title, data, refreshKey }) => {
  if (!data) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty">No data available</div>
      </>
    );
  }

  return (
    <>
      <h3 className="widget-title">{title}</h3>
      <div className="widget-data">
        {/* Widget content */}
      </div>
    </>
  );
};

export default MyWidget;
```

### Step 2: Register Widget

```javascript
// src/components/dashboard/widgetRegistry.js
import MyWidget from './widgets/MyWidget';

export const widgetRegistry = {
  // ... existing widgets
  myWidget: {
    id: 'myWidget',
    title: 'My Widget',
    component: MyWidget,
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 3, h: 2 },
    dataSource: '/api/dashboard/mydata',
    category: 'custom',
    roles: ['super_admin']
  }
};
```

### Step 3: Add to Layout

```javascript
// src/config/dashboardLayouts.js
export const dashboardLayouts = {
  super_admin: [
    // ... existing widgets
    { i: 'myWidget', x: 0, y: 12, w: 6, h: 3 }
  ]
};
```

## Role-Based Dashboards

### Super Admin Dashboard
- Full access to all widgets
- Financial metrics
- Operations overview
- Sales pipeline
- System monitoring

### Admin Dashboard
- Workforce management
- Operations overview
- Approvals queue
- System alerts
- Activity monitoring

### Manager Dashboard
- Team metrics
- Sales pipeline
- Approvals queue
- Operations overview
- Activity feed

### Employee Dashboard
- Recent activity
- Personal metrics
- Team calendar

## Layout Persistence

Layouts are automatically saved to localStorage when widgets are moved or resized.

**Storage Key Format:**
```
dashboard_layout_{role}
```

**Example:**
```javascript
localStorage.getItem('dashboard_layout_super_admin')
```

## API Integration

### Dashboard Data Endpoint
```
GET /api/dashboard/data
Authorization: Bearer {token}

Response:
{
  kpis: { ... },
  revenueTrend: [...],
  expenseBreakdown: [...],
  cashPosition: { ... },
  workforce: { ... },
  operations: { ... },
  salesPipeline: { ... },
  alerts: { ... },
  approvalsQueue: { ... },
  recentActivity: { ... }
}
```

### Insights Endpoint
```
GET /api/dashboard/insights
Authorization: Bearer {token}

Response:
{
  revenueToday: 240000,
  invoicesDue: 14,
  openTickets: 6,
  stockAlerts: 3
}
```

## Error Handling

The dashboard engine implements multiple layers of error handling:

1. **Widget Error Boundary** - Catches rendering errors in individual widgets
2. **API Fallback** - Uses mock data if API fails
3. **Layout Fallback** - Uses default layout if saved layout is corrupted
4. **Data Validation** - Validates all data before rendering

**Result:** Dashboard never disappears, even if:
- API is down
- Widget crashes
- Data is malformed
- Layout is corrupted

## Performance Features

### Lazy Loading
Widgets are loaded dynamically from the registry.

### Auto-Refresh
Dashboard data refreshes every 5 minutes automatically.

### Manual Refresh
Users can manually refresh using the refresh button.

### Layout Caching
Layouts are cached in localStorage to avoid unnecessary API calls.

## Drag-and-Drop

Powered by `react-grid-layout`:

- **Drag:** Click and hold the drag handle (⋮⋮) to move widgets
- **Resize:** Drag the bottom-right corner to resize
- **Auto-Save:** Layout saves automatically on change
- **Reset:** Click "Reset" button to restore default layout

## Responsive Behavior

### Breakpoints
- **lg:** 1200px+ (12 columns)
- **md:** 996px-1199px (12 columns)
- **sm:** 768px-995px (6 columns)
- **xs:** 480px-767px (4 columns)
- **xxs:** <480px (2 columns)

### Mobile Behavior
- Drag handles always visible
- Simplified layout
- Stacked widgets
- Touch-friendly controls

## Styling Guidelines

### Widget Container
```css
.dashboard-widget-container {
  background: white;
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
```

### Widget Title
```css
.widget-title {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 16px 0;
  padding-bottom: 12px;
  border-bottom: 2px solid #f3f4f6;
}
```

### Widget Data
```css
.widget-data {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
```

## Future Enhancements

- [ ] Backend API for layout persistence
- [ ] Widget marketplace
- [ ] Custom widget builder
- [ ] Dashboard templates
- [ ] Export dashboard as PDF
- [ ] Share dashboard with team
- [ ] Widget permissions
- [ ] Real-time data updates via WebSocket
- [ ] Dashboard analytics
- [ ] A/B testing for layouts

## Troubleshooting

### Dashboard not loading
1. Check browser console for errors
2. Verify localStorage is enabled
3. Clear dashboard layout: `localStorage.removeItem('dashboard_layout_{role}')`
4. Check API connectivity

### Widgets not dragging
1. Ensure drag handle is visible on hover
2. Check if `isDraggable` is true in ResponsiveGridLayout
3. Verify react-grid-layout CSS is loaded

### Layout not saving
1. Check localStorage quota
2. Verify saveLayout function is called
3. Check browser console for errors
4. Try resetting layout

### Data not refreshing
1. Check API endpoint connectivity
2. Verify authentication token
3. Check auto-refresh interval (5 minutes)
4. Try manual refresh button

## Support

For issues or questions, contact the development team or create an issue in the project repository.
