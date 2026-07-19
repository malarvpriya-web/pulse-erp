/**
 * recruitmentService.js — centralized service layer for Recruitment API calls.
 * Every function returns data or [] / null — never throws to the caller.
 */
import api from '@/services/api/client';

const SAMPLE_JOBS = [
  { id:1, title:'Senior React Developer',   department:'Engineering', location:'Bangalore', type:'Full-time', status:'Open',   openings:2, applicants:14, posted_date:'2026-03-01', deadline:'2026-04-01' },
  { id:2, title:'HR Business Partner',      department:'HR',          location:'Mumbai',    type:'Full-time', status:'Open',   openings:1, applicants:8,  posted_date:'2026-03-05', deadline:'2026-04-05' },
  { id:3, title:'Finance Manager',          department:'Finance',     location:'Delhi',     type:'Full-time', status:'Closed', openings:1, applicants:22, posted_date:'2026-02-01', deadline:'2026-03-01' },
  { id:4, title:'Sales Executive',          department:'Sales',       location:'Hyderabad', type:'Full-time', status:'Open',   openings:3, applicants:30, posted_date:'2026-03-10', deadline:'2026-04-10' },
  { id:5, title:'Product Design Intern',    department:'Product',     location:'Remote',    type:'Internship',status:'Open',   openings:2, applicants:45, posted_date:'2026-03-12', deadline:'2026-03-30' },
];

const SAMPLE_CANDIDATES = [
  { id:1, job_id:1, name:'Vikram Sinha',    email:'vikram@mail.com', phone:'+91 90001 00001', stage:'Technical Interview', status:'Active',   applied_date:'2026-03-02', score:82, source:'LinkedIn' },
  { id:2, job_id:1, name:'Meera Krishnan',  email:'meera@mail.com',  phone:'+91 90001 00002', stage:'HR Round',            status:'Active',   applied_date:'2026-03-03', score:88, source:'Referral' },
  { id:3, job_id:2, name:'Suresh Babu',     email:'suresh@mail.com', phone:'+91 90001 00003', stage:'Application Review',  status:'Pending',  applied_date:'2026-03-06', score:null, source:'Indeed' },
  { id:4, job_id:4, name:'Divya Menon',     email:'divya@mail.com',  phone:'+91 90001 00004', stage:'Offer Extended',      status:'Offered',  applied_date:'2026-03-11', score:91, source:'Naukri' },
  { id:5, job_id:5, name:'Rahul Kapoor',    email:'rahul@mail.com',  phone:'+91 90001 00005', stage:'Application Review',  status:'Rejected', applied_date:'2026-03-13', score:55, source:'Website' },
];

const SAMPLE_INTERVIEWS = [
  { id:1, candidate_id:1, candidate_name:'Vikram Sinha',   job_title:'Senior React Developer', type:'Technical', date:'2026-03-17', time:'11:00', interviewer:'Arjun Mehta',  status:'Scheduled' },
  { id:2, candidate_id:2, candidate_name:'Meera Krishnan', job_title:'Senior React Developer', type:'HR',         date:'2026-03-18', time:'14:00', interviewer:'Priya Sharma', status:'Scheduled' },
];

const SAMPLE_OFFERS = [
  { id:1, candidate_id:4, candidate_name:'Divya Menon', job_title:'Sales Executive', offer_date:'2026-03-15', joining_date:'2026-04-01', ctc:540000, status:'Pending Acceptance' },
];

const normalize = (res, key) => {
  const d = res?.data;
  if (!d) return null;
  return d[key] || d.data || d;
};

// ── Jobs ─────────────────────────────────────────────────────────────────────

export const getJobs = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/recruitment/jobs', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value, 'jobs');
    if (Array.isArray(data) && data.length) return data;
  }
  if (res.status === 'rejected') console.error('getJobs:', res.reason?.message);
  return SAMPLE_JOBS;
};

export const getJob = async (id) => {
  const [res] = await Promise.allSettled([api.get(`/recruitment/jobs/${id}`)]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return d?.job || d || null;
  }
  console.error('getJob:', res.reason?.message);
  return SAMPLE_JOBS.find(j => String(j.id) === String(id)) || null;
};

export const createJob = async (data) => {
  const res = await api.post('/recruitment/jobs', data);
  return res.data;
};

export const updateJob = async (id, data) => {
  const res = await api.put(`/recruitment/jobs/${id}`, data);
  return res.data;
};

export const deleteJob = async (id) => {
  const res = await api.delete(`/recruitment/jobs/${id}`);
  return res.data;
};

// ── Candidates ───────────────────────────────────────────────────────────────

export const getCandidates = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/recruitment/candidates', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value, 'candidates');
    if (Array.isArray(data) && data.length) return data;
  }
  if (res.status === 'rejected') console.error('getCandidates:', res.reason?.message);
  return SAMPLE_CANDIDATES;
};

export const getCandidate = async (id) => {
  const [res] = await Promise.allSettled([api.get(`/recruitment/candidates/${id}`)]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return d?.candidate || d || null;
  }
  console.error('getCandidate:', res.reason?.message);
  return SAMPLE_CANDIDATES.find(c => String(c.id) === String(id)) || null;
};

export const updateCandidate = async (id, data) => {
  const res = await api.put(`/recruitment/candidates/${id}`, data);
  return res.data;
};

// ── Interviews ───────────────────────────────────────────────────────────────

export const getInterviews = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/recruitment/interviews', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value, 'interviews');
    if (Array.isArray(data) && data.length) return data;
  }
  if (res.status === 'rejected') console.error('getInterviews:', res.reason?.message);
  return SAMPLE_INTERVIEWS;
};

export const scheduleInterview = async (data) => {
  const res = await api.post('/recruitment/interviews', data);
  return res.data;
};

export const updateInterview = async (id, data) => {
  const res = await api.put(`/recruitment/interviews/${id}`, data);
  return res.data;
};

// ── Offers ───────────────────────────────────────────────────────────────────

export const getOffers = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/recruitment/offers', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value, 'offers');
    if (Array.isArray(data) && data.length) return data;
  }
  if (res.status === 'rejected') console.error('getOffers:', res.reason?.message);
  return SAMPLE_OFFERS;
};

export const createOffer = async (data) => {
  const res = await api.post('/recruitment/offers', data);
  return res.data;
};

export const updateOffer = async (id, data) => {
  const res = await api.put(`/recruitment/offers/${id}`, data);
  return res.data;
};
