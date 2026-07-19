// Sample data for HR components — used as fallbacks in development only.
// Each component imports what it needs and guards with import.meta.env.DEV.

// ── AnnouncementsPanel ────────────────────────────────────────────────────────
export const SAMPLE_ANNOUNCEMENTS = [
  { id:1, title:'Q1 Performance Review Cycle Begins', priority:'Important', created_at:'2026-03-10', is_read:false },
  { id:2, title:'Office Closure – Holi (March 14)',    priority:'Normal',    created_at:'2026-03-08', is_read:true  },
  { id:3, title:'URGENT: System Maintenance Tonight',  priority:'Urgent',    created_at:'2026-03-12', is_read:false },
];
