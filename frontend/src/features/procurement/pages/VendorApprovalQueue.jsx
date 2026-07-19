/**
 * Phase 49C-9 — Vendor Approval Queue
 * Multi-stage approval: SCM → Quality → Finance → Management
 */
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

const STAGES = [
  { key: 'scm',        label: 'SCM Review',        color: '#3b82f6', statusMatch: 'Pending SCM Review' },
  { key: 'quality',    label: 'Quality Review',     color: '#8b5cf6', statusMatch: 'Pending Quality Review' },
  { key: 'finance',    label: 'Finance Review',     color: '#f59e0b', statusMatch: 'Pending Finance Review' },
  { key: 'management', label: 'Management Approval',color: '#10b981', statusMatch: 'Pending Management Review' },
];

const STATUS_COLORS = {
  'Draft':                      { bg: '#f3f4f6', color: '#6b7280' },
  'Submitted':                  { bg: '#dbeafe', color: '#1d4ed8' },
  'Under Review':               { bg: '#fef3c7', color: '#92400e' },
  'Pending SCM Review':         { bg: '#ede9fe', color: '#6d28d9' },
  'Pending Quality Review':     { bg: '#f3e8ff', color: '#6B3FDB' },
  'Pending Finance Review':     { bg: '#fef3c7', color: '#b45309' },
  'Pending Management Review':  { bg: '#d1fae5', color: '#065f46' },
  'Approved':                   { bg: '#dcfce7', color: '#16a34a' },
  'Rejected':                   { bg: '#fee2e2', color: '#dc2626' },
  'On Hold':                    { bg: '#f3f4f6', color: '#374151' },
  'Blocked':                    { bg: '#fce7f3', color: '#9d174d' },
};

const SCM_FIELDS = [
  { key: 'products_verified',   label: 'Products verified' },
  { key: 'capacity_verified',   label: 'Capacity adequate' },
  { key: 'commercial_terms',    label: 'Commercial terms acceptable' },
  { key: 'past_experience',     label: 'Past experience verified' },
];

const QUALITY_FIELDS = [
  { key: 'iso_verified',           label: 'ISO/certifications verified' },
  { key: 'inspection_capability',  label: 'Inspection capability adequate' },
  { key: 'testing_capability',     label: 'Testing capability adequate' },
  { key: 'quality_processes',      label: 'Quality processes in place' },
];

const FINANCE_FIELDS = [
  { key: 'gst_verified',        label: 'GST certificate verified' },
  { key: 'pan_verified',        label: 'PAN verified' },
  { key: 'bank_verified',       label: 'Bank details verified' },
  { key: 'compliance_ok',       label: 'Compliance check passed' },
];

function ScoreSlider({ label, value, onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: '#374151' }}>{label}</span>
        <span style={{ fontWeight: 700, color: '#6B3FDB' }}>{value}/100</span>
      </div>
      <input type="range" min={0} max={100} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#6B3FDB' }} />
    </div>
  );
}

function StatusBadge({ status }) {
  const s = STATUS_COLORS[status] || { bg: '#f3f4f6', color: '#6b7280' };
  return (
    <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  );
}

export default function VendorApprovalQueue() {
  const [queue, setQueue] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewStage, setReviewStage] = useState(null);
  const [reviewForm, setReviewForm] = useState({ decision: 'Approve', remarks: '', score: 70 });
  const [reviewChecks, setReviewChecks] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = msg => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/vendor-approval/queue', {
        params: { stage: activeTab === 'all' ? undefined : activeTab, limit: 50 },
      });
      const all = data.queue || [];
      const filtered = search
        ? all.filter(r => r.vendor_name?.toLowerCase().includes(search.toLowerCase()) || r.email?.toLowerCase().includes(search.toLowerCase()))
        : all;
      setQueue(filtered);
      setTotal(data.total || filtered.length);
    } catch { setQueue([]); }
    setLoading(false);
  }, [activeTab, search]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (reg) => {
    setSelected(reg);
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/vendor-approval/${reg.id}`);
      setDetail(data);
    } catch { setDetail(reg); }
    setDetailLoading(false);
  };

  const openReview = (stage) => {
    setReviewStage(stage);
    setReviewForm({ decision: 'Approve', remarks: '', score: 70 });
    setReviewChecks({});
  };

  const submitReview = async () => {
    if (!reviewStage || !selected) return;
    setSubmitting(true);
    try {
      const endpoint = `/vendor-approval/${selected.id}/${reviewStage}-review`;
      const payload = {
        decision: reviewForm.decision,
        remarks: reviewForm.remarks,
        [`${reviewStage === 'scm' ? 'scm' : reviewStage === 'quality' ? 'quality' : reviewStage === 'finance' ? 'finance' : 'management'}_score`]: reviewForm.score,
        ...reviewChecks,
      };
      // management uses different field names
      if (reviewStage === 'management') {
        payload.decision = reviewForm.decision === 'Approve' ? 'Approved' : reviewForm.decision === 'Reject' ? 'Rejected' : 'Conditional Approval';
      }
      await api.put(endpoint, payload);
      showToast(`${STAGES.find(s => s.key === reviewStage)?.label} submitted`);
      setReviewStage(null);
      setSelected(null);
      setDetail(null);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Review submission failed');
    }
    setSubmitting(false);
  };

  const stageLabel = STAGES.find(s => s.key === reviewStage)?.label || '';

  const getStageCheckFields = () => {
    if (reviewStage === 'scm')     return SCM_FIELDS;
    if (reviewStage === 'quality') return QUALITY_FIELDS;
    if (reviewStage === 'finance') return FINANCE_FIELDS;
    return [];
  };

  const stagesForVendor = (reg) => {
    const done = [];
    const next = [];
    if (reg.scm_reviewed_by)     done.push('SCM');
    else if (!done.length)       next.push('SCM');
    if (reg.quality_reviewed_by) done.push('Quality');
    else if (done.includes('SCM')) next.push('Quality');
    if (reg.finance_reviewed_by) done.push('Finance');
    else if (done.includes('Quality')) next.push('Finance');
    if (reg.mgmt_approved_by)    done.push('Management');
    else if (done.includes('Finance')) next.push('Management');
    return { done, next };
  };

  return (
    <div style={styles.root}>
      {toast && <div style={styles.toast}>{toast}</div>}

      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>Vendor Approval Queue</h1>
        <p style={styles.subtitle}>{total} registrations · SCM → Quality → Finance → Management</p>
      </div>

      {/* Stage tabs */}
      <div style={styles.tabs}>
        {[{ key: 'all', label: 'All Pending' }, ...STAGES].map(s => (
          <button key={s.key} onClick={() => setActiveTab(s.key)}
            style={{ ...styles.tab, ...(activeTab === s.key ? styles.tabActive : {}) }}>
            {s.label}
          </button>
        ))}
      </div>

      <div style={styles.layout}>
        {/* List panel */}
        <div style={styles.listPanel}>
          <div style={styles.searchRow}>
            <input placeholder="Search vendor name, email…" value={search}
              onChange={e => setSearch(e.target.value)} style={styles.search} />
            <button onClick={load} style={styles.btnIcon}>↺</button>
          </div>

          {loading ? (
            <div style={styles.center}>Loading…</div>
          ) : queue.length === 0 ? (
            <div style={styles.empty}>No registrations pending in this stage.</div>
          ) : (
            queue.map(reg => (
              <div key={reg.id}
                onClick={() => openDetail(reg)}
                style={{ ...styles.card, ...(selected?.id === reg.id ? styles.cardActive : {}) }}>
                <div style={styles.cardHeader}>
                  <span style={styles.vendorName}>{reg.vendor_name}</span>
                  <StatusBadge status={reg.status} />
                </div>
                <div style={styles.cardMeta}>
                  <span>{reg.vendor_type}</span>
                  <span>·</span>
                  <span>{reg.city}, {reg.state}</span>
                </div>
                <div style={styles.cardMeta}>
                  <span style={{ color: '#6b7280' }}>{reg.email}</span>
                  {reg.gstin && <><span>·</span><span style={{ color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>{reg.gstin}</span></>}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {stagesForVendor(reg).done.map(s => (
                    <span key={s} style={{ ...styles.stagePill, background: '#dcfce7', color: '#166534' }}>✓ {s}</span>
                  ))}
                  {stagesForVendor(reg).next.map(s => (
                    <span key={s} style={{ ...styles.stagePill, background: '#fef3c7', color: '#92400e' }}>⏳ {s}</span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Detail panel */}
        <div style={styles.detailPanel}>
          {!selected && (
            <div style={styles.center}>Select a registration to review</div>
          )}
          {selected && detailLoading && <div style={styles.center}>Loading details…</div>}
          {selected && !detailLoading && detail && (
            <div>
              <div style={styles.detailHeader}>
                <div>
                  <h2 style={styles.detailName}>{detail.vendor_name}</h2>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                    <StatusBadge status={detail.status} />
                    <span style={{ color: '#6b7280', fontSize: 13 }}>ID: VR-{detail.id}</span>
                    {detail.vendor_type && <span style={{ ...styles.stagePill, background: '#ede9fe', color: '#6d28d9' }}>{detail.vendor_type}</span>}
                  </div>
                </div>
                <button onClick={() => { setSelected(null); setDetail(null); }} style={styles.btnClose}>✕</button>
              </div>

              {/* Info grid */}
              <div style={styles.infoGrid}>
                <InfoRow label="GSTIN" value={detail.gstin} />
                <InfoRow label="PAN" value={detail.pan} />
                <InfoRow label="MSME" value={detail.msme_status ? 'Yes' : 'No'} />
                <InfoRow label="Udyam" value={detail.udyam_number} />
                <InfoRow label="Email" value={detail.email} />
                <InfoRow label="Phone" value={detail.phone} />
                <InfoRow label="City / State" value={`${detail.city || ''}, ${detail.state || ''}`} />
                <InfoRow label="Annual Turnover" value={detail.annual_turnover ? `₹${Number(detail.annual_turnover).toLocaleString('en-IN')}` : '—'} />
                <InfoRow label="Employees" value={detail.num_employees} />
                <InfoRow label="Year Est." value={detail.year_established} />
              </div>

              {/* Business info */}
              {detail.products_services && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Products / Services</div>
                  <div style={{ color: '#374151', fontSize: 14, lineHeight: 1.5 }}>{detail.products_services}</div>
                </div>
              )}

              {/* Scores so far */}
              {(detail.scm_score > 0 || detail.scm_quality_score > 0 || detail.finance_score > 0) && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Review Scores</div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    {detail.scm_score > 0 && <ScorePill label="SCM" score={detail.scm_score} />}
                    {detail.scm_quality_score > 0 && <ScorePill label="Quality" score={detail.scm_quality_score} />}
                    {detail.finance_score > 0 && <ScorePill label="Finance" score={detail.finance_score} />}
                  </div>
                </div>
              )}

              {/* Documents */}
              {detail.documents?.length > 0 && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Documents ({detail.documents.length})</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {detail.documents.map((d, i) => (
                      <span key={i} style={{ ...styles.stagePill, background: d.verified ? '#dcfce7' : '#eff6ff', color: d.verified ? '#166534' : '#1d4ed8' }}>
                        {d.verified ? '✓ ' : ''}{d.doc_type}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Previous remarks */}
              {(detail.scm_remarks || detail.quality_remarks || detail.finance_remarks) && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Previous Remarks</div>
                  {detail.scm_remarks && <RemarkRow stage="SCM" text={detail.scm_remarks} />}
                  {detail.quality_remarks && <RemarkRow stage="Quality" text={detail.quality_remarks} />}
                  {detail.finance_remarks && <RemarkRow stage="Finance" text={detail.finance_remarks} />}
                </div>
              )}

              {/* Action buttons */}
              <div style={styles.actionRow}>
                {STAGES.map(s => {
                  const isPending = detail.status === s.statusMatch || (s.key === 'scm' && detail.status === 'Submitted');
                  return (
                    <button key={s.key}
                      style={{ ...styles.btnStage, background: isPending ? s.color : '#f3f4f6', color: isPending ? '#fff' : '#9ca3af', cursor: isPending ? 'pointer' : 'not-allowed' }}
                      disabled={!isPending}
                      onClick={() => isPending && openReview(s.key)}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Review Modal */}
      {reviewStage && (
        <div style={styles.overlay} onClick={e => e.target === e.currentTarget && setReviewStage(null)}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h3 style={styles.modalTitle}>{stageLabel}</h3>
              <button onClick={() => setReviewStage(null)} style={styles.btnClose}>✕</button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, padding: '0 24px 24px' }}>
              {/* Checklist */}
              {getStageCheckFields().length > 0 && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Checklist</div>
                  {getStageCheckFields().map(f => (
                    <label key={f.key} style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!reviewChecks[f.key]} onChange={e => setReviewChecks(p => ({ ...p, [f.key]: e.target.checked }))} style={{ width: 16, height: 16, accentColor: '#6B3FDB' }} />
                      <span style={{ fontSize: 14, color: '#374151' }}>{f.label}</span>
                    </label>
                  ))}
                </div>
              )}

              {/* Score */}
              {reviewStage !== 'management' && (
                <div style={styles.section}>
                  <ScoreSlider label="Review Score" value={reviewForm.score} onChange={v => setReviewForm(p => ({ ...p, score: v }))} />
                </div>
              )}

              {/* Decision */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>Decision</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  {reviewStage === 'management'
                    ? ['Approved', 'Conditional Approval', 'Rejected'].map(d => (
                        <button key={d}
                          onClick={() => setReviewForm(p => ({ ...p, decision: d === 'Approved' ? 'Approve' : d === 'Rejected' ? 'Reject' : 'Conditional' }))}
                          style={{ ...styles.decisionBtn, ...(reviewForm.decision === (d === 'Approved' ? 'Approve' : d === 'Rejected' ? 'Reject' : 'Conditional') ? styles.decisionActive : {}) }}>
                          {d}
                        </button>
                      ))
                    : ['Approve', 'Hold', 'Reject'].map(d => (
                        <button key={d}
                          onClick={() => setReviewForm(p => ({ ...p, decision: d }))}
                          style={{ ...styles.decisionBtn, ...(reviewForm.decision === d ? styles.decisionActive : {}), ...(d === 'Reject' && reviewForm.decision === d ? { background: '#fee2e2', color: '#dc2626', borderColor: '#dc2626' } : {}) }}>
                          {d}
                        </button>
                      ))
                  }
                </div>
              </div>

              {/* Remarks */}
              <div>
                <label style={styles.label}>Remarks {reviewForm.decision !== 'Approve' ? '*' : '(optional)'}</label>
                <textarea value={reviewForm.remarks} onChange={e => setReviewForm(p => ({ ...p, remarks: e.target.value }))}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, minHeight: 80, resize: 'vertical', boxSizing: 'border-box' }}
                  placeholder="Enter your review remarks…" />
              </div>
            </div>

            <div style={{ padding: '16px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setReviewStage(null)} style={styles.btnSecondary}>Cancel</button>
              <button onClick={submitReview} disabled={submitting} style={styles.btnPrimary}>
                {submitting ? 'Submitting…' : 'Submit Review'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }) {
  return value ? (
    <div style={{ padding: '5px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 10 }}>
      <span style={{ color: '#6b7280', fontSize: 13, width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#111827', fontSize: 13 }}>{value}</span>
    </div>
  ) : null;
}

function RemarkRow({ stage, text }) {
  return (
    <div style={{ background: '#f9fafb', borderRadius: 6, padding: '8px 12px', marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>{stage}</div>
      <div style={{ fontSize: 13, color: '#374151' }}>{text}</div>
    </div>
  );
}

function ScorePill({ label, score }) {
  const color = score >= 70 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626';
  return (
    <div style={{ textAlign: 'center', padding: '8px 16px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{score}</div>
      <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
    </div>
  );
}

const styles = {
  root: { minHeight: '100vh', background: '#f3f4f6', fontFamily: 'system-ui, sans-serif' },
  header: { background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '20px 24px' },
  title: { fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 },
  subtitle: { color: '#6b7280', fontSize: 14, marginTop: 4 },
  tabs: { display: 'flex', gap: 0, background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '0 24px', overflowX: 'auto' },
  tab: { padding: '10px 18px', background: 'none', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#6b7280', whiteSpace: 'nowrap' },
  tabActive: { color: '#6B3FDB', borderBottomColor: '#6B3FDB' },
  layout: { display: 'flex', height: 'calc(100vh - 130px)', overflow: 'hidden' },
  listPanel: { width: 360, borderRight: '1px solid #e5e7eb', background: '#fff', overflowY: 'auto', flexShrink: 0 },
  detailPanel: { flex: 1, overflowY: 'auto', padding: 24, background: '#fafafa' },
  searchRow: { padding: '12px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 8 },
  search: { flex: 1, padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 },
  btnIcon: { padding: '7px 12px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 16 },
  card: { padding: '14px 16px', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', transition: 'background .15s' },
  cardActive: { background: '#f5f3ff' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  vendorName: { fontWeight: 600, color: '#111827', fontSize: 14 },
  cardMeta: { display: 'flex', gap: 6, fontSize: 12, color: '#6b7280', marginTop: 3 },
  stagePill: { padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 500 },
  detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  detailName: { fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 },
  infoGrid: { background: '#fff', borderRadius: 10, padding: '12px 16px', marginBottom: 16, border: '1px solid #e5e7eb' },
  section: { background: '#fff', borderRadius: 10, padding: '14px 16px', marginBottom: 14, border: '1px solid #e5e7eb' },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  actionRow: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20 },
  btnStage: { padding: '10px 18px', borderRadius: 6, border: 'none', fontWeight: 600, fontSize: 13 },
  center: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#9ca3af', fontSize: 14 },
  empty: { padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 14 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: 12, width: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.2)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' },
  modalTitle: { fontSize: 17, fontWeight: 700, color: '#111827', margin: 0 },
  btnClose: { background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280', padding: '4px 8px' },
  label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 4 },
  decisionBtn: { padding: '8px 20px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontWeight: 500, fontSize: 13 },
  decisionActive: { background: '#ede9fe', color: '#6d28d9', borderColor: '#6B3FDB' },
  btnPrimary: { padding: '10px 24px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  btnSecondary: { padding: '10px 24px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  toast: { position: 'fixed', bottom: 24, right: 24, background: '#111827', color: '#fff', padding: '12px 20px', borderRadius: 8, zIndex: 2000, fontSize: 14 },
};
