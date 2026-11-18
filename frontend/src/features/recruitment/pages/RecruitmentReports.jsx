import { useState, useEffect, useCallback } from 'react';
import {
  Download, RefreshCw, Users, Clock, Target, AlertTriangle, CheckCircle, BarChart3, FileSignature,
} from 'lucide-react';
import api from '@/services/api/client';
import { exportCSV } from '@/features/_shared/exportUtils';
import { fmtDate, localDay } from '@/utils/dateFormatter';
import { sourceLabel, stageLabel } from '../shared/constants';
import { PageHero, PageShell, Stat } from '@/components/pulse-ui';

/**
 * Recruitment Reports (Recruitment → Reports & Setup → Reports).
 *
 * Review 2026-11-17 — what was wrong and is fixed:
 *  • "To" date dropped its own day (the API compared timestamps to midnight),
 *    so today's candidates never appeared under the default range.
 *  • Department filter was sent to four reports and honoured by one.
 *  • Vacancy Aging kept only jobs CREATED in the range — with the default 60
 *    days a job could never reach the 60-day "At Risk" mark. It now shows every
 *    job open right now (the date range does not apply to it, and says so).
 *  • "Hire by source" counted every candidate, not hires, and repeated the
 *    Source tab with four hard-coded sources. Removed; the Source tab has all.
 *  • Dept Pipeline left out Shortlisted, Assessment and Selected.
 *  • Dates were the UTC day (a day behind IST before 05:30).
 *  • New: Offers report — outcome, why declined / withdrawn, days to answer.
 */

const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);
const PIPE_STAGES = ['applied', 'screening', 'shortlisted', 'assessment', '1st_level', '2nd_level', 'offer', 'selected', 'hired'];
const OFFER_STATUS = { draft: 'Draft', pending_approval: 'Pending approval', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn' };

function SectionHeader({ title, note, onExport }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12, gap: 10, flexWrap: 'wrap' }}>
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>{title}</h3>
        {note && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{note}</div>}
      </div>
      {onExport && (
        <button type="button" onClick={onExport} className="pulse-btn-secondary" style={{ fontSize: 12 }}>
          <Download size={13} /> Export CSV
        </button>
      )}
    </div>
  );
}

const TableWrap = ({ children }) => (
  <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>{children}</table>
  </div>
);
const TH = ({ children, right }) => (
  <th style={{ padding: '10px 14px', textAlign: right ? 'right' : 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', background: '#f9fafb' }}>{children}</th>
);
const TD = ({ children, right, bold }) => (
  <td style={{ padding: '10px 14px', textAlign: right ? 'right' : 'left', color: bold ? '#111827' : '#374151', fontWeight: bold ? 600 : 400, borderBottom: '1px solid #f3f4f6' }}>{children}</td>
);
const Empty = ({ children }) => (
  <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 40, textAlign: 'center', color: '#9ca3af' }}>{children}</div>
);

const fieldLbl = { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.04em' };
const fieldInp = { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', background: '#fff' };

const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'aging', label: 'Vacancy Aging' },
  { key: 'source', label: 'Source Effectiveness' },
  { key: 'pipeline', label: 'Dept Pipeline' },
  { key: 'offers', label: 'Offers' },
];

export default function RecruitmentReports({ embedded = false }) {
  const [fromDate, setFromDate] = useState(() => localDay(-60));
  const [toDate, setToDate] = useState(() => localDay());
  const [dept, setDept] = useState('');
  const [tab, setTab] = useState('summary');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deptList, setDeptList] = useState([]);

  const [summary, setSummary] = useState(null);
  const [aging, setAging] = useState([]);
  const [source, setSource] = useState([]);
  const [pipeline, setPipeline] = useState([]);
  const [offers, setOffers] = useState({ totals: null, rows: [] });

  const badRange = fromDate && toDate && fromDate > toDate;

  const load = useCallback(async () => {
    if (badRange) return;
    setLoading(true);
    const params = { from_date: fromDate, to_date: toDate };
    if (dept) params.department = dept;
    const [sumRes, ageRes, srcRes, pipRes, offRes] = await Promise.allSettled([
      api.get('/recruitment/reports/summary', { params }),
      api.get('/recruitment/reports/vacancy-aging', { params: dept ? { department: dept } : {} }),
      api.get('/recruitment/reports/source-effectiveness', { params }),
      api.get('/recruitment/reports/department-pipeline', { params }),
      api.get('/recruitment/reports/offers', { params }),
    ]);
    setSummary(sumRes.status === 'fulfilled' ? sumRes.value.data : null);
    setAging(ageRes.status === 'fulfilled' && Array.isArray(ageRes.value.data) ? ageRes.value.data : []);
    setSource(srcRes.status === 'fulfilled' && Array.isArray(srcRes.value.data) ? srcRes.value.data : []);
    setPipeline(pipRes.status === 'fulfilled' && Array.isArray(pipRes.value.data) ? pipRes.value.data : []);
    setOffers(offRes.status === 'fulfilled' && offRes.value.data ? offRes.value.data : { totals: null, rows: [] });
    const failed = [sumRes, ageRes, srcRes, pipRes, offRes].filter(r => r.status === 'rejected');
    setError(failed.length ? (failed[0].reason?.response?.data?.error || 'Some reports could not be loaded.') : '');
    setLoading(false);
  }, [fromDate, toDate, dept, badRange]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.filter(d => d.is_active !== false).map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  const s = summary || {};
  const o = offers.totals || {};
  const rangeText = `${fmtDate(fromDate)} – ${fmtDate(toDate)}${dept ? ` · ${dept}` : ''}`;

  const body = (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap', alignItems: 'flex-end', background: '#fff', padding: 14, borderRadius: 12, border: '1px solid #f0f0f4' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={fieldLbl}>From</span>
          <input type="date" value={fromDate} max={toDate || undefined} onChange={e => setFromDate(e.target.value)} style={fieldInp} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={fieldLbl}>To</span>
          <input type="date" value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)} style={fieldInp} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={fieldLbl}>Department</span>
          <select value={dept} onChange={e => setDept(e.target.value)} style={{ ...fieldInp, minWidth: 170 }}>
            <option value="">All departments</option>
            {deptList.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <button type="button" className="pulse-btn-secondary" onClick={load}><RefreshCw size={14} /> Refresh</button>
        {badRange && <span style={{ color: '#b91c1c', fontSize: 12 }}>"From" is after "To".</span>}
      </div>

      {error && <div style={{ padding: 12, color: '#b91c1c', background: '#fef2f2', borderRadius: 10, marginBottom: 14, fontSize: 13 }}>{error}</div>}

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 20 }}>
          <Stat icon={Users} label="Candidates added" value={s.total_candidates ?? 0} sub="in the period" color="#4B2DCE" />
          <Stat icon={Target} label="Still in process" value={s.active_pipeline ?? 0} sub="of those added" color="#0891b2" />
          <Stat icon={CheckCircle} label="Hired" value={s.hired_in_period ?? 0} sub="hire date in the period" color="#16a34a" />
          <Stat icon={Clock} label="Avg time to hire" value={s.avg_time_to_hire != null ? `${s.avg_time_to_hire}d` : '—'} sub="added → hired" color="#6d28d9" />
          <Stat icon={FileSignature} label="Offer acceptance" value={pct(o.acceptance_rate)} sub={`${o.accepted || 0} of ${(o.sent || 0) + (o.accepted || 0) + (o.declined || 0)} offers made`} color="#6B3FDB" />
        </div>
      )}

      <div role="tablist" style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: tab === t.key ? '#6B3FDB' : '#f3f4f6', color: tab === t.key ? '#fff' : '#374151' }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>
      ) : (
        <>
          {tab === 'summary' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
              <div>
                <SectionHeader title="Candidates added in the period" note={rangeText}
                  onExport={() => exportCSV([{ added: s.total_candidates, in_process: s.active_pipeline, hired: s.total_hired, rejected: s.total_rejected }], 'candidates_summary')} />
                <TableWrap>
                  <thead><tr><TH>Where they are now</TH><TH right>Candidates</TH><TH right>Share</TH></tr></thead>
                  <tbody>
                    {[['Still in process', s.active_pipeline], ['Hired', s.total_hired], ['Rejected', s.total_rejected],
                      ['Other (withdrew, parked)', Math.max(0, (s.total_candidates || 0) - (s.active_pipeline || 0) - (s.total_hired || 0) - (s.total_rejected || 0))]]
                      .map(([label, v]) => (
                        <tr key={label}><TD>{label}</TD><TD right bold>{v || 0}</TD><TD right>{s.total_candidates ? pct(((v || 0) / s.total_candidates) * 100) : '—'}</TD></tr>
                      ))}
                    <tr><TD bold>Total added</TD><TD right bold>{s.total_candidates || 0}</TD><TD right /></tr>
                  </tbody>
                </TableWrap>
              </div>
              <div>
                <SectionHeader title="Offers in the period" note="By the day the offer went out (drafts by when they were made)" />
                <TableWrap>
                  <thead><tr><TH>Offers</TH><TH right>Count</TH></tr></thead>
                  <tbody>
                    {[['Draft / awaiting approval', o.awaiting_approval], ['Sent, no answer yet', o.sent], ['Accepted', o.accepted],
                      ['Declined', o.declined], ['Withdrawn', o.withdrawn]].map(([label, v]) => (
                      <tr key={label}><TD>{label}</TD><TD right bold>{v || 0}</TD></tr>
                    ))}
                    <tr><TD>Average days to answer</TD><TD right bold>{o.avg_days_to_answer ?? '—'}</TD></tr>
                  </tbody>
                </TableWrap>
              </div>
            </div>
          )}

          {tab === 'aging' && (
            <div>
              <SectionHeader title="Jobs open right now, by age"
                note={`Every open or paused job${dept ? ` in ${dept}` : ''}. The date range does not apply — this is today's position. Over 60 days open = at risk.`}
                onExport={() => exportCSV(aging.map(r => ({
                  job_title: r.job_title, department: r.department, status: r.status, opened_on: r.opened_on, days_open: r.days_open,
                  closing_date: r.closing_date || '', positions: r.number_of_positions, filled: r.positions_filled,
                  applicants: r.applicant_count, active_applicants: r.active_applicants, risk: r.days_open > 60 ? 'At risk' : 'Normal',
                })), 'vacancy_aging')} />
              {aging.length === 0 ? <Empty>No open jobs{dept ? ` in ${dept}` : ''}.</Empty> : (
                <TableWrap>
                  <thead><tr>
                    <TH>Job</TH><TH>Department</TH><TH>Opened</TH><TH right>Days open</TH><TH>Closing</TH>
                    <TH right>Seats</TH><TH right>Filled</TH><TH right>Applicants (active)</TH><TH>Risk</TH>
                  </tr></thead>
                  <tbody>
                    {aging.map(r => {
                      const atRisk = r.days_open > 60;
                      return (
                        <tr key={r.id}>
                          <TD bold>{r.job_title}{r.status === 'on_hold' && <span style={{ fontSize: 11, color: '#92400e', fontWeight: 500 }}> · paused</span>}</TD>
                          <TD>{r.department || '—'}</TD>
                          <TD>{fmtDate(r.opened_on)}</TD>
                          <TD right bold>{r.days_open}</TD>
                          <TD>{r.closing_date ? fmtDate(r.closing_date) : '—'}</TD>
                          <TD right>{r.number_of_positions}</TD>
                          <TD right>{r.positions_filled}</TD>
                          <TD right>{r.applicant_count} ({r.active_applicants})</TD>
                          <TD>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                              background: atRisk ? '#fee2e2' : '#d1fae5', color: atRisk ? '#991b1b' : '#065f46' }}>
                              {atRisk && <AlertTriangle size={10} />}{atRisk ? 'At risk' : 'Normal'}
                            </span>
                          </TD>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableWrap>
              )}
            </div>
          )}

          {tab === 'source' && (
            <div>
              <SectionHeader title="Where candidates came from" note={`Candidates added ${rangeText}, by source, and how far they got`}
                onExport={() => exportCSV(source.map(r => ({ source: sourceLabel(r.source), candidates: r.total_applications, in_process: r.in_progress, hired: r.hires, rejected: r.rejections, hire_rate_pct: r.hire_rate_pct })), 'source_effectiveness')} />
              {source.length === 0 ? <Empty>No candidates in this period.</Empty> : (
                <TableWrap>
                  <thead><tr><TH>Source</TH><TH right>Candidates</TH><TH right>In process</TH><TH right>Hired</TH><TH right>Rejected</TH><TH right>Hire rate</TH></tr></thead>
                  <tbody>
                    {source.map(r => (
                      <tr key={r.source}>
                        <TD bold>{sourceLabel(r.source)}</TD>
                        <TD right>{r.total_applications}</TD>
                        <TD right>{r.in_progress}</TD>
                        <TD right>{r.hires}</TD>
                        <TD right>{r.rejections}</TD>
                        <TD right>{pct(r.hire_rate_pct)}</TD>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </div>
          )}

          {tab === 'pipeline' && (
            <div>
              <SectionHeader title="Applications by department and stage"
                note={`Applications made ${rangeText}. A candidate put forward to two jobs counts once per job. Columns add up to Total.`}
                onExport={() => exportCSV(pipeline.map(r => ({
                  department: r.department, total: r.total,
                  ...Object.fromEntries(PIPE_STAGES.map(st => [stageLabel(st), r[st] || 0])),
                  rejected: r.rejected, parked: r.parked,
                })), 'department_pipeline')} />
              {pipeline.length === 0 ? <Empty>No applications in this period.</Empty> : (
                <TableWrap>
                  <thead><tr>
                    <TH>Department</TH><TH right>Total</TH>
                    {PIPE_STAGES.map(st => <TH key={st} right>{stageLabel(st)}</TH>)}
                    <TH right>Rejected</TH><TH right>Parked</TH>
                  </tr></thead>
                  <tbody>
                    {pipeline.map(r => (
                      <tr key={r.department}>
                        <TD bold>{r.department}</TD>
                        <TD right bold>{r.total}</TD>
                        {PIPE_STAGES.map(st => <TD key={st} right>{r[st] || 0}</TD>)}
                        <TD right>{r.rejected}</TD>
                        <TD right>{r.parked}</TD>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </div>
          )}

          {tab === 'offers' && (
            <div>
              <SectionHeader title="Offers" note={`${rangeText} · acceptance ${pct(o.acceptance_rate)} · average ${o.avg_days_to_answer ?? '—'} days to answer`}
                onExport={() => exportCSV(offers.rows.map(r => ({
                  offer_no: r.offer_no, candidate: r.candidate_name, designation: r.designation, department: r.department || '',
                  annual_ctc: r.offered_salary, status: OFFER_STATUS[r.offer_status] || r.offer_status, sent_on: r.sent_on || '',
                  valid_until: r.valid_until || '', answered_on: r.answered_on || '', days_to_answer: r.days_to_answer ?? '', reason: r.close_reason || '',
                })), 'offers_report')} />
              {offers.rows.length === 0 ? <Empty>No offers in this period.</Empty> : (
                <TableWrap>
                  <thead><tr><TH>Offer</TH><TH>Candidate</TH><TH>Position</TH><TH right>Annual CTC</TH><TH>Status</TH><TH>Sent</TH><TH>Answered</TH><TH right>Days</TH><TH>Reason</TH></tr></thead>
                  <tbody>
                    {offers.rows.map(r => (
                      <tr key={r.id}>
                        <TD>{r.offer_no || '—'}</TD>
                        <TD bold>{r.candidate_name}</TD>
                        <TD>{r.designation || '—'}{r.department ? <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.department}</div> : null}</TD>
                        <TD right>₹{Math.round(r.offered_salary || 0).toLocaleString('en-IN')}</TD>
                        <TD>{OFFER_STATUS[r.offer_status] || r.offer_status}</TD>
                        <TD>{r.sent_on ? fmtDate(r.sent_on) : '—'}</TD>
                        <TD>{r.answered_on ? fmtDate(r.answered_on) : '—'}</TD>
                        <TD right>{r.days_to_answer ?? '—'}</TD>
                        <TD>{r.close_reason || '—'}</TD>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </div>
          )}
        </>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={<PageHero icon={BarChart3} eyebrow="Recruitment" title="Recruitment Reports" subtitle="Candidates, vacancy aging, sources, department pipeline and offers" />}>
      {body}
    </PageShell>
  );
}
