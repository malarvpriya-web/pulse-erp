# 🎯 Dynamic Role-Based ERP Dashboard

A fully configurable, widget-driven dashboard that automatically adapts to user roles and permissions.

## ✨ Features

### Core Functionality
- ✅ **Role-Based Widgets** - Automatically shows relevant widgets based on user role (Executive/Manager/Employee)
- ✅ **Drag & Drop** - Rearrange widgets by dragging them
- ✅ **Show/Hide Widgets** - Toggle widget visibility with checkboxes
- ✅ **Persistent Layout** - User preferences saved in localStorage
- ✅ **Real-Time Data** - Fetches live data from backend APIs
- ✅ **Responsive Design** - Works on desktop, tablet, and mobile
- ✅ **Interactive Charts** - Line charts, bar charts, and KPI cards
- ✅ **Security** - Only displays data user has permission to view

### Dashboard Types

#### 📊 Executive Dashboard (Admin/Executive Role)
- **Revenue Overview** - Monthly revenue, YTD, trend chart
- **Profitability** - Gross profit, net profit, expenses
- **Cash Position** - Bank balance, inflow/outflow, upcoming payments
- **Sales Pipeline** - Open deals, won/lost deals, win rate
- **Workforce Snapshot** - Total employees, new hires, attrition, attendance
- **Operations Snapshot** - Open tickets, active projects, overdue tasks, stock alerts
- **Notifications** - High-priority alerts

#### 👨‍💼 Manager Dashboard
- **Team Attendance Today** - Present/Absent/Late counts
- **Pending Approvals** - Leave, expense, purchase, timesheet approvals
- **Project Health** - Active projects, overdue tasks, budget utilization
- **Team Performance** - Utilization %, goal completion %
- **Department Spend** - Monthly expenses vs budget with chart
- **Notifications** - Team-related alerts

#### 👩‍💻 Employee Dashboard
- **My Attendance** - Today's status, monthly attendance chart
- **My Leave** - Leave balances by type, upcoming leaves
- **My Tasks** - Tasks due today, overdue tasks
- **My Approvals** - Pending/approved/rejected requests
- **My Payslips** - Latest payslip download
- **Announcements** - Company news, birthdays, work anniversaries

## 📁 File Structure

```
frontend/src/
├── pages/
│   ├── ERPDashboard.jsx          # Main dashboard component
│   └── ERPDashboard.css          # Dashboard styles
├── components/
│   └── dashboard/
│       ├── Widget.jsx             # Widget wrapper component
│       └── widgets/
│           ├── RevenueWidget.jsx           # Executive widgets
│           ├── ProfitabilityWidget.jsx
│           ├── CashPositionWidget.jsx
│           ├── SalesPipelineWidget.jsx
│           ├── WorkforceWidget.jsx
│           ├── OperationsWidget.jsx
│           ├── TeamAttendanceWidget.jsx    # Manager widgets
│           ├── PendingApprovalsWidget.jsx
│           ├── ProjectHealthWidget.jsx
│           ├── TeamPerformanceWidget.jsx
│           ├── DeptSpendWidget.jsx
│           ├── MyAttendanceWidget.jsx      # Employee widgets
│           ├── MyLeaveWidget.jsx
│           ├── MyTasksWidget.jsx
│           ├── MyApprovalsWidget.jsx
│           ├── MyPayslipsWidget.jsx
│           ├── AnnouncementsWidget.jsx
│           └── NotificationsWidget.jsx
└── config/
    └── dashboardConfig.js         # Widget configuration by role

backend/src/modules/dashboard/
├── dashboard.controller.js        # Data fetching logic
└── dashboard.routes.js            # API routes
```

## 🚀 Installation

### 1. Install Required Packages

```bash
cd frontend
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities chart.js react-chartjs-2
```

### 2. Backend is Already Configured
The dashboard routes are integrated into `backend/server.js`

### 3. Access the Dashboard
Navigate to the Dashboard from the sidebar menu

## 🔧 Configuration

### Adding New Widgets

#### Step 1: Create Widget Component
Create a new file in `frontend/src/components/dashboard/widgets/`:

```jsx
// MyNewWidget.jsx
export function MyNewWidget({ data }) {
  return (
    <div className="widget-data">
      <div className="kpi-card">
        <span className="kpi-label">My Metric</span>
        <span className="kpi-value">{data?.value || 0}</span>
      </div>
    </div>
  );
}

export default MyNewWidget;
```

#### Step 2: Register Widget Type
Add to `frontend/src/config/dashboardConfig.js`:

```javascript
export const WIDGET_TYPES = {
  // ... existing types
  MY_NEW_WIDGET: "myNewWidget"
};

// Add to appropriate role array
const EXECUTIVE_WIDGETS = [
  // ... existing widgets
  { 
    id: "myNew", 
    title: "My New Widget", 
    type: WIDGET_TYPES.MY_NEW_WIDGET, 
    dataKey: "myNewData", 
    size: "medium" 
  }
];
```

#### Step 3: Import in Widget.jsx
Add to `frontend/src/components/dashboard/Widget.jsx`:

```javascript
import MyNewWidget from "./widgets/MyNewWidget";

const WIDGET_COMPONENTS = {
  // ... existing components
  [WIDGET_TYPES.MY_NEW_WIDGET]: MyNewWidget
};
```

#### Step 4: Add Backend Data
Update `backend/src/modules/dashboard/dashboard.controller.js`:

```javascript
const getExecutiveDashboardData = async () => {
  return {
    // ... existing data
    myNewData: {
      value: 123
    }
  };
};
```

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/dashboard` | GET | Get logged-in user info |
| `/api/dashboard/data` | GET | Get dashboard data based on role |

## 🎨 Widget Sizes

Widgets support three sizes:
- **small** - 1 column width
- **medium** - 1 column width
- **large** - 2 columns width (on desktop)

## 🔒 Security

- All API calls require authentication token
- Backend filters data based on user role
- Widgets only display if user has permission
- No sensitive data exposed to unauthorized users

## 💾 Data Persistence

User preferences are saved in localStorage:
- Widget visibility (shown/hidden)
- Widget order (drag & drop positions)
- Key: `dashboard_{userId}`

## 📱 Responsive Behavior

- **Desktop (>1024px)**: Multi-column grid, large widgets span 2 columns
- **Tablet (768-1024px)**: Single column, all widgets same width
- **Mobile (<768px)**: Single column, stacked layout

## 🎯 Usage Examples

### Accessing the Dashboard
1. Login to the application
2. Click "Dashboard" in the sidebar
3. Dashboard loads with role-appropriate widgets

### Customizing Layout
1. **Rearrange**: Drag widgets to new positions
2. **Hide**: Uncheck widget in controls at top
3. **Reset**: Click "Reset Layout" to restore defaults

### Drill-Down Navigation
Click on widget elements to navigate to detailed views (implement navigation handlers as needed)

## 🔄 Data Refresh

Currently displays static/sample data. To add real-time updates:

1. Add polling in `ERPDashboard.jsx`:
```javascript
useEffect(() => {
  const interval = setInterval(() => {
    fetchUserAndDashboard();
  }, 60000); // Refresh every minute
  return () => clearInterval(interval);
}, []);
```

2. Or add manual refresh button:
```jsx
<button onClick={fetchUserAndDashboard}>Refresh</button>
```

## 🎨 Styling

All styles are in `ERPDashboard.css`. Key classes:
- `.widget` - Widget container
- `.kpi-card` - KPI metric card
- `.kpi-value` - Large metric value
- `.progress-bar` - Progress indicator
- `.alert-box` - Alert/warning box

## 🐛 Troubleshooting

### Widgets not showing
- Check user role in localStorage
- Verify widget is in role's widget array
- Check browser console for errors

### Drag & drop not working
- Ensure @dnd-kit packages are installed
- Check that sensors are configured correctly

### Data not loading
- Verify backend is running on port 5000
- Check authentication token is valid
- Review network tab for API errors

## 📈 Future Enhancements

- [ ] Real-time data updates via WebSocket
- [ ] Export dashboard as PDF
- [ ] Share dashboard layouts between users
- [ ] Custom widget builder UI
- [ ] Advanced filtering and date ranges
- [ ] Widget-level permissions
- [ ] Dashboard templates
- [ ] Mobile app version

## 👥 Role Mapping

The dashboard maps these roles:
- `admin` → Executive Dashboard
- `executive` → Executive Dashboard
- `manager` → Manager Dashboard
- `employee` → Employee Dashboard
- `user` → Employee Dashboard (default)

## 📝 Notes

- Widget data is currently sample/mock data
- Connect to real database queries for production
- Add error boundaries for widget failures
- Consider caching strategies for performance
- Implement proper loading states
- Add empty states for widgets with no data

## 🤝 Contributing

To add new dashboard features:
1. Create widget component
2. Update configuration
3. Add backend data source
4. Test with different roles
5. Update documentation

---

**Built with React, Chart.js, and dnd-kit**
