# Home Portal Celebrations Widget - Testing Guide

## Overview
The celebrations widget displays today's birthdays and work anniversaries on the Home portal.

## API Endpoint
**GET** `/api/home/celebrations`

**Response Format:**
```json
[
  {
    "id": 1,
    "name": "John Doe",
    "type": "Birthday",
    "department": "Finance",
    "designation": "Senior Analyst"
  },
  {
    "id": 2,
    "name": "Jane Smith",
    "type": "Work Anniversary",
    "years": 5,
    "department": "HR",
    "designation": "HR Manager"
  }
]
```

## Display Format

### With Celebrations
```
🎂 John Doe
Finance
Birthday

🎉 Jane Smith
HR
Work Anniversary (5 years)
```

### Without Celebrations
```
No celebrations today
```

## Backend Logic

### Birthday Detection
```javascript
const dob = new Date(emp.dob);
if (dob.getMonth() === today.getMonth() && dob.getDate() === today.getDate()) {
  // It's their birthday!
}
```

### Work Anniversary Detection
```javascript
const joinDate = new Date(emp.joining_date);
if (joinDate.getMonth() === today.getMonth() && 
    joinDate.getDate() === today.getDate() &&
    joinDate.getFullYear() < today.getFullYear()) {
  const years = today.getFullYear() - joinDate.getFullYear();
  // It's their work anniversary!
}
```

## Setup Test Data

### Option 1: Run Test Script
```bash
cd backend
node add-celebration-test-data.js
```

This will add:
- John Doe with birthday today
- Jane Smith with work anniversary today (5 years)
- Mike Johnson with both birthday and work anniversary today

### Option 2: Manual SQL Insert
```sql
-- Get today's date in format YYYY-MM-DD
-- Example: 2026-03-15

-- Add employee with birthday today
INSERT INTO employees (
  first_name, last_name, company_email, department, designation,
  dob, joining_date, status
) VALUES (
  'John', 'Doe', 'john.doe@company.com', 'Finance', 'Senior Analyst',
  '1990-03-15', '2020-01-15', 'Active'
);

-- Add employee with work anniversary today (joined 5 years ago)
INSERT INTO employees (
  first_name, last_name, company_email, department, designation,
  dob, joining_date, status
) VALUES (
  'Jane', 'Smith', 'jane.smith@company.com', 'HR', 'HR Manager',
  '1985-05-20', '2021-03-15', 'Active'
);
```

## Testing Steps

### 1. Test API Endpoint
```bash
# Test the celebrations endpoint
curl http://localhost:5000/api/home/celebrations
```

**Expected Response:**
```json
[
  {
    "id": 123,
    "name": "John Doe",
    "type": "Birthday",
    "department": "Finance",
    "designation": "Senior Analyst"
  },
  {
    "id": 124,
    "name": "Jane Smith",
    "type": "Work Anniversary",
    "years": 5,
    "department": "HR",
    "designation": "HR Manager"
  }
]
```

### 2. Test Frontend Display
1. Start backend: `npm run dev`
2. Start frontend: `npm run dev`
3. Login with any user
4. Navigate to Home page
5. Check "Today's Celebrations" widget

**Expected Display:**
- Employee name in bold
- Department below name
- Celebration type (Birthday or Work Anniversary)
- Years for work anniversaries
- Proper icons (🎂 for birthday, 🎉 for anniversary)

### 3. Test Empty State
1. Remove all test employees or set dates to different days
2. Refresh Home page

**Expected Display:**
```
No celebrations today
```

### 4. Test Multiple Celebrations
1. Add 3-5 employees with birthdays/anniversaries today
2. Refresh Home page

**Expected:**
- All celebrations displayed
- Scrollable if more than 3-4 items
- Proper spacing between items

## Frontend Implementation

### State Management
```javascript
const [celebrations, setCelebrations] = useState([]);
```

### Data Fetching
```javascript
const fetchCelebrations = async () => {
  try {
    const response = await api.get("/home/celebrations");
    setCelebrations(response.data || []);
  } catch (err) {
    console.error("Error fetching celebrations:", err);
    setCelebrations([]);
  }
};
```

### Promise.all() Usage
```javascript
const loadAllData = async () => {
  setLoading(true);
  try {
    await Promise.all([
      fetchAnnouncements(),
      fetchUpcomingEvents(),
      fetchCelebrations(),
      fetchPolicies(),
      fetchDownloads(),
      fetchHolidays()
    ]);
  } catch (err) {
    console.error("Error loading home data:", err);
  } finally {
    setLoading(false);
  }
};
```

### Display Component
```jsx
<div className="home-widget">
  <h3><FaBirthdayCake /> Today's Celebrations</h3>
  <div className="home-scroll large">
    {celebrations.length > 0 ? (
      celebrations.map((cel, i) => (
        <div key={i} style={{ marginBottom: "12px", padding: "12px", background: "#f9fafb", borderRadius: "8px" }}>
          <p style={{ fontWeight: "600" }}>
            {getCelebrationIcon(cel.type)} {cel.name}
          </p>
          <p style={{ color: "#6b7280" }}>
            {cel.department || 'N/A'}
          </p>
          <p style={{ color: "#0284c7", fontWeight: "500" }}>
            {cel.type}{cel.years ? ` (${cel.years} years)` : ''}
          </p>
        </div>
      ))
    ) : (
      <p style={{ color: "#9ca3af", textAlign: "center" }}>No celebrations today</p>
    )}
  </div>
</div>
```

## Troubleshooting

### Issue: No celebrations showing
**Check:**
1. Are there employees with dob or joining_date matching today?
2. Is the employee status 'Active'?
3. Check browser console for API errors
4. Verify API endpoint returns data

**Solution:**
```bash
# Check database
psql -d your_database -c "SELECT first_name, last_name, dob, joining_date FROM employees WHERE status = 'Active';"

# Run test data script
node add-celebration-test-data.js
```

### Issue: Wrong dates showing
**Check:**
1. Server timezone vs database timezone
2. Date parsing in JavaScript

**Solution:**
```javascript
// Ensure proper date comparison
const today = new Date();
const dob = new Date(emp.dob);
console.log('Today:', today.getMonth(), today.getDate());
console.log('DOB:', dob.getMonth(), dob.getDate());
```

### Issue: Celebrations not updating
**Check:**
1. Browser cache
2. API caching

**Solution:**
```bash
# Clear browser cache
# Or hard refresh: Ctrl+Shift+R (Windows) / Cmd+Shift+R (Mac)

# Restart backend
npm run dev
```

## Expected Behavior

### Birthday
- Shows on the exact date of birth (month and day)
- Ignores year (shows every year)
- Icon: 🎂
- Format: "Birthday"

### Work Anniversary
- Shows on the exact date of joining (month and day)
- Only shows if joined in a previous year
- Calculates years of service
- Icon: 🎉
- Format: "Work Anniversary (X years)"

### Multiple Celebrations Same Person
If an employee has both birthday and work anniversary on the same day:
- Shows two separate entries
- One for birthday
- One for work anniversary

## Performance Considerations

### Database Query
- Fetches all active employees
- Filters in application layer (JavaScript)
- Consider moving filter to SQL for large datasets

### Optimization for Large Datasets
```sql
-- Optimized query (future enhancement)
SELECT 
  id, first_name, last_name, dob, joining_date, department, designation
FROM employees
WHERE status = 'Active'
  AND (
    EXTRACT(MONTH FROM dob) = EXTRACT(MONTH FROM CURRENT_DATE)
    AND EXTRACT(DAY FROM dob) = EXTRACT(DAY FROM CURRENT_DATE)
  )
  OR (
    EXTRACT(MONTH FROM joining_date) = EXTRACT(MONTH FROM CURRENT_DATE)
    AND EXTRACT(DAY FROM joining_date) = EXTRACT(DAY FROM CURRENT_DATE)
    AND EXTRACT(YEAR FROM joining_date) < EXTRACT(YEAR FROM CURRENT_DATE)
  );
```

## Success Criteria

✅ API returns correct celebration data
✅ Frontend displays celebrations in correct format
✅ Empty state shows "No celebrations today"
✅ Icons display correctly (🎂 for birthday, 🎉 for anniversary)
✅ Department shows below name
✅ Years show for work anniversaries
✅ Multiple celebrations display properly
✅ Data fetches with Promise.all()
✅ Loading state works
✅ Error handling works
