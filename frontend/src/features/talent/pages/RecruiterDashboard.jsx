import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  Users, Briefcase, Calendar, FileText,
  AlertCircle, Clock, Plus, Video,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import './RecruiterDashboard.css';

const STAGE_LABELS = {
  applied:     'Applied',
  screening:   'Screening',
  '1st_level': '1st Level',
  '2nd_level': '2nd Level',
  offer:       'Offer',
  hired:       'Hired',
};

const STAGE_COLORS = ['#c4b5fd', '#a78bfa', '#8b5cf6', '#6B3FDB', '#6d28d9', '#4c1d95'];

const SOURCE_COLORS = {
  linkedin:   '#0077b5',
  referral:   '#10b981',
  website:    '#6366f1',
  job_portal: '#f59e0b',
  walk_in:    '#ef4444',
};

function fmtDays(days) {
  if (days == null) return 'N/A';
  return `${days}d`;
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function fmtTime(t) {
  if (!t) return '';
  return String(t).slice(0, 5);
}

function srcColor(source) {
  return SOURCE_COLORS[source] || '#6b7280';
}

export default function RecruiterDashboard({ setPage }) {
  const toast = useToast();
  const [loading,         setLoading]         = useState(true);
  const [stats,           setStats]           = useState({});
  const [pipeline,        setPipeline]        = useState([]);
  const [todayInterviews, setTodayInterviews] = useState([]);
  const [recentApps,      setRecentApps]      = useState([]);
  const [expiringOffers,  setExpiringOffers]  = useState([]);
  const [actionItems,     setActionItems]     = useState([]);

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      const res = await api.get('/talent/recruiter-dashboard');
      const d   = res.data?.data ?? {};
      setStats(d.stats ?? {});
      setPipeline(d.pipeline ?? []);
      setTodayInterviews(d.today_interviews ?? []);
      setRecentApps(d.recent_applications ?? []);
      setExpiringOffers(d.expiring_offers ?? []);
      setActionItems(d.action_items ?? []);
    } catch {
      toast.error('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDashboard(); }, []);

  const kpis = [
    { label: 'Open Positions',       value: stats?.open_positions        ?? 0,              icon: Briefcase,    color: '#6366f1' },
    { label: 'Total Candidates',     value: stats?.total_candidates      ?? 0,              icon: Users,        color: '#10b981' },
    { label: 'Upcoming Interviews',  value: stats?.upcoming_interviews   ?? 0,              icon: Calendar,     color: '#f59e0b' },
    { label: 'Pending Offers',       value: stats?.pending_offers        ?? 0,              icon: FileText,     color: '#3b82f6' },
    {
      label: 'Expiring Offers',
      value: stats?.expiring_offers_count ?? 0,
      icon:  AlertCircle,
      color: (stats?.expiring_offers_count ?? 0) > 0 ? '#ef4444' : '#9ca3af',
      alert: (stats?.expiring_offers_count ?? 0) > 0,
    },
    { label: 'Avg Time to Hire',     value: fmtDays(stats?.avg_time_to_hire),              icon: Clock,        color: '#8b5cf6', isText: true },
  ];

  const chartData = pipeline.map(p => ({
    stage: STAGE_LABELS[p.stage] ?? p.stage,
    count: p.count,
  }));

  return (
    <div className="rd-root">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="rd-header">
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
            Recruiter Dashboard
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', margin: '2px 0 0', fontSize: 13 }}>
            Today's hiring workload at a glance
          </p>
        </div>
        <button className="rd-btn-outline" onClick={fetchDashboard}>Refresh</button>
      </div>

      {/* ── Quick Actions ───────────────────────────────────────── */}
      <div className="rd-quick-actions">
        <button className="rd-qa-btn" onClick={() => setPage?.('JobOpenings')}>
          <Plus size={13}/> Post Job
        </button>
        <button className="rd-qa-btn" onClick={() => setPage?.('InterviewScheduler')}>
          <Plus size={13}/> Schedule Interview
        </button>
        <button className="rd-qa-btn" onClick={() => setPage?.('OfferManagement')}>
          <Plus size={13}/> Create Offer
        </button>
        <button className="rd-qa-btn rd-qa-btn-ghost" onClick={() => setPage?.('CandidatePipeline')}>
          View Pipeline
        </button>
      </div>

      {/* ── KPI Cards ───────────────────────────────────────────── */}
      {loading ? (
        <div className="rd-skeleton-wrap" style={{ marginBottom: 20 }}>
          {[0, 1, 2].map(i => <div key={i} className="rd-skeleton-row"/>)}
        </div>
      ) : (
        <div className="rd-kpi-grid rd-kpi-grid-6">
          {kpis.map(k => (
            <div
              key={k.label}
              className="rd-kpi-card"
              style={k.alert ? { borderColor: '#fecaca', background: '#fff5f5' } : {}}
            >
              <div className="rd-kpi-icon" style={{ background: k.color + '18' }}>
                <k.icon size={17} color={k.color}/>
              </div>
              <div>
                <p className="rd-kpi-label">{k.label}</p>
                <p
                  className="rd-kpi-value"
                  style={{
                    fontSize: k.isText ? 18 : 22,
                    color:    k.alert  ? '#ef4444' : undefined,
                  }}
                >
                  {loading ? '—' : k.value}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Today's Interviews ──────────────────────────────────── */}
      <div className="rd-section-card" style={{ marginBottom: 16 }}>
        <div className="rd-section-header">
          <h2 className="rd-panel-title" style={{ margin: 0 }}>Today's Interviews</h2>
          {!loading && (
            <span className="rd-badge-count" style={todayInterviews.length === 0 ? { background: '#9ca3af' } : {}}>
              {todayInterviews.length}
            </span>
          )}
        </div>
        {loading ? (
          <div className="rd-panel-empty">Loading…</div>
        ) : todayInterviews.length === 0 ? (
          <div className="rd-panel-empty">No interviews scheduled for today</div>
        ) : (
          <div className="rd-interview-table">
            <div className="rd-interview-thead">
              <span>Time</span>
              <span>Candidate</span>
              <span>Job</span>
              <span>Mode</span>
              <span>Interviewer</span>
              <span></span>
            </div>
            {todayInterviews.map(iv => (
              <div key={iv.id} className="rd-interview-row">
                <span className="rd-interview-time">{fmtTime(iv.interview_time)}</span>
                <span className="rd-interview-name">{iv.candidate_name}</span>
                <span className="rd-interview-job">{iv.job_title || '—'}</span>
                <span className="rd-interview-mode">{iv.interview_mode || '—'}</span>
                <span className="rd-interview-interviewer">{iv.interviewer_name || '—'}</span>
                <span>
                  {iv.meeting_link && (
                    <a href={iv.meeting_link} target="_blank" rel="noreferrer" className="rd-join-btn">
                      <Video size={11}/> Join
                    </a>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Pipeline + Action Required ──────────────────────────── */}
      <div className="rd-panels" style={{ marginBottom: 16 }}>
        {/* Pipeline chart */}
        <div className="rd-panel">
          <h2 className="rd-panel-title">Candidate Pipeline</h2>
          {loading ? (
            <div className="rd-panel-empty">Loading…</div>
          ) : pipeline.length === 0 ? (
            <div className="rd-panel-empty">No candidate data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 24, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f4"/>
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false}/>
                <YAxis type="category" dataKey="stage" tick={{ fontSize: 11 }} width={80}/>
                <Tooltip formatter={(v) => [v, 'Candidates']}/>
                <Bar dataKey="count" radius={[0, 4, 4, 0]} name="Candidates">
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={STAGE_COLORS[i] ?? '#6B3FDB'}/>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Action Required */}
        <div className="rd-panel">
          <h2 className="rd-panel-title">Action Required</h2>
          {loading ? (
            <div className="rd-panel-empty">Loading…</div>
          ) : actionItems.length === 0 && expiringOffers.length === 0 ? (
            <div className="rd-panel-empty">No pending actions — all clear!</div>
          ) : (
            <div className="rd-activity-list">
              {actionItems.map(item => (
                <div key={`stale-${item.id}`} className="rd-activity-item">
                  <span className="rd-activity-badge" style={{ background: '#fff7ed', color: '#c2410c' }}>
                    STALE
                  </span>
                  <div className="rd-activity-info">
                    <div className="rd-activity-name">{item.name}</div>
                    <div className="rd-activity-meta">
                      {STAGE_LABELS[item.stage] ?? item.stage}
                      {item.job_title ? ` · ${item.job_title}` : ''}
                    </div>
                  </div>
                  <span className="rd-activity-time" style={{ color: '#ef4444' }}>
                    {item.days_waiting}d waiting
                  </span>
                </div>
              ))}
              {expiringOffers.map(offer => (
                <div key={`offer-${offer.id}`} className="rd-activity-item">
                  <span className="rd-activity-badge" style={{ background: '#fee2e2', color: '#dc2626' }}>
                    OFFER
                  </span>
                  <div className="rd-activity-info">
                    <div className="rd-activity-name">{offer.candidate_name}</div>
                    <div className="rd-activity-meta">{offer.position}</div>
                  </div>
                  <span className="rd-activity-time" style={{ color: '#ef4444' }}>
                    exp {fmtDate(offer.offer_expiry_date)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Recent Applications ─────────────────────────────────── */}
      <div className="rd-section-card">
        <div className="rd-section-header">
          <h2 className="rd-panel-title" style={{ margin: 0 }}>Recent Applications</h2>
          <button
            className="rd-btn-outline"
            style={{ fontSize: 11, padding: '4px 10px' }}
            onClick={() => navigate('/ResumeDatabase')}
          >
            View All
          </button>
        </div>
        {loading ? (
          <div className="rd-panel-empty">Loading…</div>
        ) : recentApps.length === 0 ? (
          <div className="rd-panel-empty">No applications in the last 7 days</div>
        ) : (
          <div className="rd-activity-list">
            {recentApps.map(app => (
              <div key={app.id} className="rd-activity-item">
                <div className="rd-activity-info">
                  <div className="rd-activity-name">{app.name}</div>
                  <div className="rd-activity-meta">{app.applied_for || 'No position'}</div>
                </div>
                {app.source && (
                  <span
                    className="rd-activity-badge"
                    style={{
                      background: srcColor(app.source) + '22',
                      color:      srcColor(app.source),
                    }}
                  >
                    {app.source}
                  </span>
                )}
                <span className="rd-activity-time">{fmtDate(app.applied_date)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
