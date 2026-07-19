// Travel feature fixtures — sample/mock data for development only.
// Consumed via import.meta.env.DEV guards in component files.

// TravelAnalytics
export const SAMPLE_STATS_ANALYTICS = { ytdSpend: 842000, avgTripCost: 14200, totalTrips: 59, policyViolations: 3 };

// TravelAnalytics
export const SAMPLE_TREND_ANALYTICS = [
  { month: 'Apr', amount: 68000 }, { month: 'May', amount: 74000 }, { month: 'Jun', amount: 52000 },
  { month: 'Jul', amount: 89000 }, { month: 'Aug', amount: 95000 }, { month: 'Sep', amount: 78000 },
  { month: 'Oct', amount: 95000 }, { month: 'Nov', amount: 120000 }, { month: 'Dec', amount: 88000 },
  { month: 'Jan', amount: 134000 }, { month: 'Feb', amount: 115000 }, { month: 'Mar', amount: 142000 },
];

// TravelAnalytics
export const SAMPLE_DEPT = [
  { dept: 'Sales', flights: 85000, hotels: 42000, meals: 15000, transport: 12000 },
  { dept: 'Engineering', flights: 62000, hotels: 28000, meals: 10000, transport: 8000 },
  { dept: 'Finance', flights: 35000, hotels: 18000, meals: 7000, transport: 5000 },
  { dept: 'HR', flights: 28000, hotels: 12000, meals: 5000, transport: 4000 },
  { dept: 'Ops', flights: 45000, hotels: 22000, meals: 9000, transport: 7000 },
];

// TravelAnalytics
export const SAMPLE_CATEGORY_ANALYTICS = [
  { name: 'Flights', value: 255000, color: '#6366f1' },
  { name: 'Hotels', value: 122000, color: '#8b5cf6' },
  { name: 'Meals', value: 46000, color: '#a78bfa' },
  { name: 'Transport', value: 36000, color: '#c4b5fd' },
  { name: 'Misc', value: 28000, color: '#e0e7ff' },
];

// TravelAnalytics
export const SAMPLE_TRAVELERS = [
  { employee: 'Vikram Singh', trips: 9, spend: 118000 },
  { employee: 'Arjun Mehta', trips: 8, spend: 98000 },
  { employee: 'Priya Sharma', trips: 7, spend: 89000 },
  { employee: 'Rohit Gupta', trips: 6, spend: 82000 },
  { employee: 'Sneha Iyer', trips: 5, spend: 74000 },
];

// TravelCalendar
export const SAMPLE_TRIPS = [
  { id: 1, employee: 'Arjun Mehta', destination: 'Mumbai', travelDate: '2026-03-20', returnDate: '2026-03-21', status: 'Approved', color: '#6366f1' },
  { id: 2, employee: 'Priya Sharma', destination: 'Bengaluru', travelDate: '2026-03-25', returnDate: '2026-03-27', status: 'Approved', color: '#8b5cf6' },
  { id: 3, employee: 'Rahul Verma', destination: 'Delhi', travelDate: '2026-03-25', returnDate: '2026-03-28', status: 'Pending', color: '#f59e0b' },
  { id: 4, employee: 'Sneha Iyer', destination: 'Chennai', travelDate: '2026-03-28', returnDate: '2026-03-29', status: 'Approved', color: '#10b981' },
  { id: 5, employee: 'Kiran Das', destination: 'Hyderabad', travelDate: '2026-04-01', returnDate: '2026-04-02', status: 'Pending', color: '#f59e0b' },
  { id: 6, employee: 'Vikram Singh', destination: 'Nagpur', travelDate: '2026-03-22', returnDate: '2026-03-23', status: 'Approved', color: '#6366f1' },
  { id: 7, employee: 'Meera Joshi', destination: 'Bengaluru', travelDate: '2026-03-28', returnDate: '2026-03-30', status: 'Pending', color: '#f59e0b' },
];

// TravelDashboard
export const SAMPLE_STATS_DASHBOARD = { totalTrips: 24, pendingApprovals: 5, expensesThisMonth: 142000, advanceBalance: 38500 };

// TravelDashboard
export const SAMPLE_REQUESTS = [
  { id: 1, employee: 'Arjun Mehta', destination: 'Mumbai', purpose: 'Client Meeting', travelDate: '2026-03-20', status: 'Pending' },
  { id: 2, employee: 'Priya Sharma', destination: 'Bengaluru', purpose: 'Conference', travelDate: '2026-03-22', status: 'Approved' },
  { id: 3, employee: 'Rahul Verma', destination: 'Delhi', purpose: 'Training', travelDate: '2026-03-25', status: 'Pending' },
  { id: 4, employee: 'Sneha Iyer', destination: 'Chennai', purpose: 'Audit', travelDate: '2026-03-28', status: 'Approved' },
  { id: 5, employee: 'Kiran Das', destination: 'Hyderabad', purpose: 'Sales Visit', travelDate: '2026-04-01', status: 'Draft' },
];

// TravelDashboard
export const SAMPLE_TREND_DASHBOARD = [
  { month: 'Oct', amount: 95000 }, { month: 'Nov', amount: 120000 }, { month: 'Dec', amount: 88000 },
  { month: 'Jan', amount: 134000 }, { month: 'Feb', amount: 115000 }, { month: 'Mar', amount: 142000 },
];

// TravelDashboard
export const SAMPLE_CATEGORY_DASHBOARD = [
  { name: 'Flights', value: 62000, color: '#6366f1' },
  { name: 'Hotels', value: 41000, color: '#8b5cf6' },
  { name: 'Meals', value: 18000, color: '#a78bfa' },
  { name: 'Transport', value: 14000, color: '#c4b5fd' },
  { name: 'Misc', value: 7000, color: '#e0e7ff' },
];

// TravelAdvances
export const SAMPLE_ADVANCES = [
  { id: 1, advanceNo: 'ADV-001', tripRef: 'TR-002', employee: 'Priya Sharma', purpose: 'Conference travel advance', requestedAmount: 15000, disbursedAmount: 15000, requestedDate: '2026-03-18', status: 'Disbursed' },
  { id: 2, advanceNo: 'ADV-002', tripRef: 'TR-001', employee: 'Arjun Mehta', purpose: 'Client visit advance', requestedAmount: 4000, disbursedAmount: 0, requestedDate: '2026-03-16', status: 'Approved' },
  { id: 3, advanceNo: 'ADV-003', tripRef: 'TR-006', employee: 'Vikram Singh', purpose: 'Sales trip advance', requestedAmount: 4500, disbursedAmount: 0, requestedDate: '2026-03-20', status: 'Pending' },
  { id: 4, advanceNo: 'ADV-004', tripRef: 'TR-010', employee: 'Rohit Gupta', purpose: 'Kolkata site visit', requestedAmount: 20000, disbursedAmount: 0, requestedDate: '2026-03-22', status: 'Pending' },
  { id: 5, advanceNo: 'ADV-005', tripRef: 'TR-004', employee: 'Sneha Iyer', purpose: 'Chennai audit advance', requestedAmount: 12000, disbursedAmount: 12000, requestedDate: '2026-02-08', status: 'Settled' },
];

// TravelApprovals
export const SAMPLE_APPROVALS = [
  { id: 1, requestNo: 'TR-006', employee: 'Vikram Singh', department: 'Sales', purpose: 'Customer Visit', fromCity: 'Pune', toCity: 'Nagpur', travelDate: '2026-03-22', returnDate: '2026-03-23', mode: 'Train', estimatedBudget: 5200, advanceRequired: true, status: 'Pending' },
  { id: 2, requestNo: 'TR-007', employee: 'Meera Joshi', department: 'Engineering', purpose: 'Tech Conference', fromCity: 'Pune', toCity: 'Bengaluru', travelDate: '2026-03-28', returnDate: '2026-03-30', mode: 'Air', estimatedBudget: 20000, advanceRequired: true, status: 'Pending' },
  { id: 3, requestNo: 'TR-008', employee: 'Suresh Nair', department: 'Finance', purpose: 'Board Meeting', fromCity: 'Pune', toCity: 'Mumbai', travelDate: '2026-03-19', returnDate: '2026-03-19', mode: 'Car', estimatedBudget: 3000, advanceRequired: false, status: 'Approved' },
  { id: 4, requestNo: 'TR-009', employee: 'Anika Patel', department: 'HR', purpose: 'Recruitment Drive', fromCity: 'Pune', toCity: 'Delhi', travelDate: '2026-03-15', returnDate: '2026-03-16', mode: 'Air', estimatedBudget: 14000, advanceRequired: true, status: 'Rejected' },
  { id: 5, requestNo: 'TR-010', employee: 'Rohit Gupta', department: 'Operations', purpose: 'Site Inspection', fromCity: 'Pune', toCity: 'Kolkata', travelDate: '2026-04-05', returnDate: '2026-04-07', mode: 'Air', estimatedBudget: 25000, advanceRequired: true, status: 'Pending' },
];

// TravelBookings
export const SAMPLE_BOOKINGS = [
  { id: 1, bookingRef: 'BK-001', type: 'Flight', tripRef: 'TR-002', details: 'IndiGo 6E-241 PNQ→BLR', travelDate: '2026-03-25', amount: 5800, bookedBy: 'Self', status: 'Confirmed' },
  { id: 2, bookingRef: 'BK-002', type: 'Hotel', tripRef: 'TR-002', details: 'Marriott Bengaluru, 2 nights', travelDate: '2026-03-25', amount: 9600, bookedBy: 'Admin', status: 'Confirmed' },
  { id: 3, bookingRef: 'BK-003', type: 'Flight', tripRef: 'TR-001', details: 'Vande Bharat PNQ→CSTM', travelDate: '2026-03-20', amount: 1200, bookedBy: 'Self', status: 'Completed' },
  { id: 4, bookingRef: 'BK-004', type: 'Cab', tripRef: 'TR-001', details: 'Airport transfer — Ola Corporate', travelDate: '2026-03-20', amount: 650, bookedBy: 'Self', status: 'Completed' },
  { id: 5, bookingRef: 'BK-005', type: 'Flight', tripRef: 'TR-003', details: 'Air India AI-865 PNQ→DEL', travelDate: '2026-04-02', amount: 7200, bookedBy: 'Admin', status: 'Pending' },
];

// TravelExpenses
export const SAMPLE_EXPENSES = [
  { id: 1, claimNo: 'EX-001', tripRef: 'TR-001', description: 'Mumbai Client Visit', totalAmount: 4850, submittedDate: '2026-03-22', status: 'Approved' },
  { id: 2, claimNo: 'EX-002', tripRef: 'TR-004', description: 'Chennai Audit Trip', totalAmount: 16200, submittedDate: '2026-02-14', status: 'Settled' },
  { id: 3, claimNo: 'EX-003', tripRef: 'TR-002', description: 'Bengaluru Conference', totalAmount: 19400, submittedDate: '2026-03-26', status: 'Pending' },
  { id: 4, claimNo: 'EX-004', tripRef: 'TR-005', description: 'Hyderabad Sales', totalAmount: 11800, submittedDate: '2026-02-24', status: 'Rejected' },
  { id: 5, claimNo: 'EX-005', tripRef: 'TR-008', description: 'Mumbai Board Meeting', totalAmount: 3200, submittedDate: '2026-03-20', status: 'Draft' },
];

// TravelRequests
export const SAMPLE_TRAVEL_REQUESTS = [
  { id: 1, requestNo: 'TR-001', purpose: 'Client Meeting', fromCity: 'Pune', toCity: 'Mumbai', travelDate: '2026-03-20', returnDate: '2026-03-21', mode: 'Train', estimatedBudget: 4500, advanceRequired: true, status: 'Approved' },
  { id: 2, requestNo: 'TR-002', purpose: 'Annual Conference', fromCity: 'Pune', toCity: 'Bengaluru', travelDate: '2026-03-25', returnDate: '2026-03-27', mode: 'Air', estimatedBudget: 18000, advanceRequired: true, status: 'Pending' },
  { id: 3, requestNo: 'TR-003', purpose: 'Training Program', fromCity: 'Pune', toCity: 'Delhi', travelDate: '2026-04-02', returnDate: '2026-04-05', mode: 'Air', estimatedBudget: 22000, advanceRequired: false, status: 'Draft' },
  { id: 4, requestNo: 'TR-004', purpose: 'Vendor Audit', fromCity: 'Pune', toCity: 'Chennai', travelDate: '2026-02-10', returnDate: '2026-02-12', mode: 'Air', estimatedBudget: 16000, advanceRequired: true, status: 'Completed' },
  { id: 5, requestNo: 'TR-005', purpose: 'Sales Visit', fromCity: 'Pune', toCity: 'Hyderabad', travelDate: '2026-02-20', returnDate: '2026-02-21', mode: 'Air', estimatedBudget: 12000, advanceRequired: false, status: 'Rejected' },
];
