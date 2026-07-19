// Sample data for Notifications — used as fallbacks in development only.
// Guard with import.meta.env.DEV at every usage site.

// ── NotificationDropdown ──────────────────────────────────────────────────────
export const SAMPLE_NOTIFICATIONS = [
  { id:1, notification_type:'leave_approved',     title:'Leave Request Approved',       message:'Your Annual Leave request (Mar 18-20) has been approved by HR.',   is_read:false, created_at: new Date(Date.now()-7200000).toISOString() },
  { id:2, notification_type:'payroll_processed',   title:'Salary Credited — March 2026', message:'Your March salary of ₹91,757 has been processed.',                  is_read:false, created_at: new Date(Date.now()-86400000).toISOString() },
  { id:3, notification_type:'timesheet_approved',  title:'Timesheet Approved',           message:'Timesheet for week of Mar 9–15 approved by Priya Mehta.',          is_read:true,  created_at: new Date(Date.now()-172800000).toISOString() },
  { id:4, notification_type:'announcement',        title:'Office Holiday — Apr 14',      message:'Office closed on Apr 14 (Dr. Ambedkar Jayanti).',                   is_read:true,  created_at: new Date(Date.now()-259200000).toISOString() },
  { id:5, notification_type:'complaint_assigned',  title:'Complaint Assigned to You',    message:'CMP-2026-003 has been assigned to you for resolution.',              is_read:true,  created_at: new Date(Date.now()-345600000).toISOString() },
];
