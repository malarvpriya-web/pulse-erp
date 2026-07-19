// Shared constants for the complaints module — single source of truth for
// statuses, transitions, and priority metadata.

export const STATUS_META = {
  open:        { bg:'#fee2e2', color:'#dc2626', label:'Open'        },
  in_progress: { bg:'#dbeafe', color:'#1e40af', label:'In Progress' },
  on_hold:     { bg:'#e0e7ff', color:'#4338ca', label:'On Hold'     },
  resolved:    { bg:'#dcfce7', color:'#166534', label:'Resolved'    },
  closed:      { bg:'#f3f4f6', color:'#6b7280', label:'Closed'      },
};
export const sm = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.open;

export const PRIORITY_META = {
  critical: { color:'#7e22ce', bg:'#fdf4ff' },
  high:     { color:'#dc2626', bg:'#fee2e2' },
  medium:   { color:'#92400e', bg:'#fef3c7' },
  low:      { color:'#9ca3af', bg:'#f3f4f6' },
};
export const pd = p => (PRIORITY_META[(p || '').toLowerCase()] || PRIORITY_META.medium).color;
export const pm = p => PRIORITY_META[(p || '').toLowerCase()] || PRIORITY_META.medium;

// Must mirror backend complaints.routes.js VALID_TRANSITIONS
export const VALID_TRANSITIONS = {
  open:        ['in_progress', 'resolved', 'closed'],
  in_progress: ['resolved', 'on_hold', 'closed'],
  on_hold:     ['in_progress', 'closed'],
  resolved:    ['closed', 'open'],
  closed:      [],
};

export const STATUSES   = ['open', 'in_progress', 'on_hold', 'resolved', 'closed'];
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
export const CATEGORIES = ['Payroll', 'Leave', 'IT', 'Finance', 'HR', 'Operations', 'Other'];
