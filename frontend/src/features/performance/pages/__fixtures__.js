// ─── Fixtures for performance/pages ───────────────────────────────────────────
// Dev-only sample data. Import and wrap with import.meta.env.DEV guards.

// PerformanceReviews.jsx
export const SAMPLE_REVIEW = {
  id: 1,
  period: 'Q4 2025 (Oct – Dec)',
  cycle: 'Annual Review 2025',
  status: 'self_review_pending',
  self_rating: null,
  manager_rating: null,
  final_rating: null,
  self_submitted_at: null,
  manager_reviewed_at: null,
  strengths: '',
  improvements: '',
  manager_comments: '',
};

// PerformanceReviews.jsx
export const SAMPLE_GOALS = [
  { id: 1, title: 'Deliver Q4 feature roadmap', category: 'Delivery', progress: 85, target: 100, status: 'on_track', due: 'Dec 31 2025', weight: 30 },
  { id: 2, title: 'Reduce bug backlog by 40%', category: 'Quality', progress: 62, target: 100, status: 'on_track', due: 'Dec 31 2025', weight: 20 },
  { id: 3, title: 'Complete React advanced course', category: 'Learning', progress: 40, target: 100, status: 'at_risk', due: 'Dec 31 2025', weight: 15 },
  { id: 4, title: 'Mentor 2 junior developers', category: 'Leadership', progress: 100, target: 100, status: 'completed', due: 'Oct 15 2025', weight: 20 },
  { id: 5, title: 'Improve code review turnaround', category: 'Process', progress: 70, target: 100, status: 'on_track', due: 'Dec 31 2025', weight: 15 },
];

// PerformanceReviews.jsx
export const SAMPLE_COMPETENCIES = [
  { subject: 'Technical Skills', self: 4.2, manager: 3.8, fullMark: 5 },
  { subject: 'Communication', self: 3.5, manager: 3.9, fullMark: 5 },
  { subject: 'Leadership', self: 3.8, manager: 4.1, fullMark: 5 },
  { subject: 'Problem Solving', self: 4.5, manager: 4.2, fullMark: 5 },
  { subject: 'Collaboration', self: 4.0, manager: 4.3, fullMark: 5 },
  { subject: 'Innovation', self: 3.6, manager: 3.5, fullMark: 5 },
];

// PerformanceReviews.jsx
export const SAMPLE_HISTORY = [
  { id: 1, cycle: 'Annual Review 2024', period: 'Jan – Dec 2024', final_rating: 4.1, manager: 'Priya Mehta', completed_at: 'Jan 15 2025', badge: 'Exceeds Expectations' },
  { id: 2, cycle: 'Mid-Year 2024', period: 'Jan – Jun 2024', final_rating: 3.8, manager: 'Priya Mehta', completed_at: 'Jul 10 2024', badge: 'Meets Expectations' },
  { id: 3, cycle: 'Annual Review 2023', period: 'Jan – Dec 2023', final_rating: 3.5, manager: 'Rahul Singh', completed_at: 'Jan 20 2024', badge: 'Meets Expectations' },
];

// Goals.jsx
export const SAMPLE_GOALS_LIST = [
  { id: 1, title: 'Increase Sales Pipeline by 30%',      description: 'Expand outreach and qualify 50+ leads per quarter', targetDate: '2026-03-31', weightage: 25, progress: 72, status: 'Active',    category: 'Sales' },
  { id: 2, title: 'Complete PMP Certification',           description: 'Pass the Project Management Professional exam',    targetDate: '2026-04-30', weightage: 15, progress: 45, status: 'Active',    category: 'Learning' },
  { id: 3, title: 'Improve Customer Satisfaction Score',  description: 'Achieve CSAT score of 90% or above',              targetDate: '2026-03-15', weightage: 20, progress: 100, status: 'Completed', category: 'Quality' },
  { id: 4, title: 'Launch Q2 Product Feature',            description: 'Ship the new reporting module on time',           targetDate: '2026-02-28', weightage: 30, progress: 30, status: 'Overdue',   category: 'Product' },
  { id: 5, title: 'Reduce Operational Costs by 10%',      description: 'Identify and eliminate inefficiencies in process', targetDate: '2026-06-30', weightage: 10, progress: 20, status: 'Active',    category: 'Operations' },
];

// TeamPerformance.jsx
export const SAMPLE_TEAM = [
  { id: 1, employee: 'Vikram Singh',  role: 'Sr. Sales Manager', rating: 4.8, goalsTotal: 5, goalsCompleted: 5, attendance: 97, score: 94, trend: 'up' },
  { id: 2, employee: 'Arjun Mehta',   role: 'Sales Manager',     rating: 4.5, goalsTotal: 4, goalsCompleted: 4, attendance: 95, score: 88, trend: 'up' },
  { id: 3, employee: 'Priya Sharma',  role: 'Sales Executive',   rating: 4.2, goalsTotal: 4, goalsCompleted: 3, attendance: 93, score: 80, trend: 'stable' },
  { id: 4, employee: 'Sneha Iyer',    role: 'Sales Executive',   rating: 4.6, goalsTotal: 3, goalsCompleted: 3, attendance: 98, score: 91, trend: 'up' },
  { id: 5, employee: 'Kiran Das',     role: 'BD Manager',        rating: 3.8, goalsTotal: 5, goalsCompleted: 2, attendance: 88, score: 65, trend: 'down' },
  { id: 6, employee: 'Rohit Gupta',   role: 'Sales Manager',     rating: 4.1, goalsTotal: 4, goalsCompleted: 3, attendance: 91, score: 78, trend: 'stable' },
  { id: 7, employee: 'Meera Joshi',   role: 'Engineer',          rating: 4.7, goalsTotal: 6, goalsCompleted: 6, attendance: 96, score: 92, trend: 'up' },
  { id: 8, employee: 'Suresh Nair',   role: 'Finance Lead',      rating: 4.3, goalsTotal: 4, goalsCompleted: 3, attendance: 94, score: 83, trend: 'stable' },
];
