// ─── Fixtures for documents/pages ─────────────────────────────────────────────
// Dev-only sample data. Import and wrap with import.meta.env.DEV guards.

// DocumentSigning.jsx
export const SAMPLE_DOCS = [
  { id:1, title:'Employment Contract – Arjun Mehta',     type:'Employment Contract',    recipient:'Arjun Mehta',    recipient_email:'arjun@company.com',   sent_date:'2026-03-01', status:'signed',   signed_date:'2026-03-02' },
  { id:2, title:'NDA – TechCorp Solutions',               type:'NDA',                   recipient:'Rajesh Kumar',   recipient_email:'rajesh@techcorp.com',  sent_date:'2026-03-05', status:'sent',     signed_date:null },
  { id:3, title:'Appraisal Letter – Priya Sharma',        type:'Appraisal Letter',      recipient:'Priya Sharma',   recipient_email:'priya@company.com',    sent_date:'2026-03-08', status:'pending',  signed_date:null },
  { id:4, title:'Policy Acknowledgement – Q1 2026',       type:'Policy Acknowledgement',recipient:'All Employees',  recipient_email:'all@company.com',      sent_date:'2026-03-10', status:'sent',     signed_date:null },
  { id:5, title:'Offer Letter – Karthik Rajan',           type:'Offer Letter',          recipient:'Karthik Rajan', recipient_email:'karthik@gmail.com',    sent_date:'2026-02-28', status:'signed',   signed_date:'2026-03-01' },
  { id:6, title:'Relieving Letter – Manish Gupta',        type:'Relieving Letter',      recipient:'Manish Gupta',  recipient_email:'manish@company.com',   sent_date:'2026-03-12', status:'declined', signed_date:null },
];
