import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Wallet } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

/* ── constants ────────────────────────────────────────────────────────────── */

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const EX_STATUSES = new Set([
  'left','terminated','resigned','inactive',
  'ex-employee','notice_period','notice period',
]);

function yearRange() {
  const y = new Date().getFullYear();
  const years = [];
  for (let i = y - 3; i <= y + 1; i++) years.push(i);
  return years;
}

const BULK_BATCH_SIZE = 5;
const EMPTY_BULK = { show: false, active: false, rows: [], sent: 0, failed: 0 };

const STATUS_ICON  = { queued: '⏳', sending: '🔄', sent: '✅', failed: '❌' };
const STATUS_COLOR = { queued: '#9ca3af', sending: '#6B3FDB', sent: '#16a34a', failed: '#dc2626' };

const MSG_STYLE = {
  success: { background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' },
  error:   { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' },
  warning: { background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe' },
};

const PRINT_CSS = `
  @media print {
    body * { visibility: hidden; }
    #payslip-preview, #payslip-preview * { visibility: visible; }
    #payslip-preview { position: fixed; left: 0; top: 0; width: 100%; }
  }
`;

/* ── helpers ──────────────────────────────────────────────────────────────── */

// A payslip shows exact rupees — never "₹3.39 L".
function fmtINR(n) {
  return `₹${Math.round(parseFloat(n) || 0).toLocaleString('en-IN')}`;
}

function numWords(n) {
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen',
    'Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  if (n === 0)       return 'Zero';
  if (n < 0)         return 'Minus ' + numWords(-n);
  if (n < 20)        return ones[n];
  if (n < 100)       return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  if (n < 1000)      return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + numWords(n % 100) : '');
  if (n < 100000)    return numWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + numWords(n % 1000) : '');
  if (n < 10000000)  return numWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + numWords(n % 100000) : '');
  return numWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + numWords(n % 10000000) : '');
}

function empDisplayName(e) {
  return `${e.first_name || ''} ${e.last_name || ''}`.trim() || e.name || '—';
}

/* ── component ────────────────────────────────────────────────────────────── */

export default function PayslipGenerator({ embedded = false } = {}) {
  const [employees,   setEmployees]   = useState([]);
  const [empSearch,   setEmpSearch]   = useState('');
  const [loadingEmps, setLoadingEmps] = useState(true);
  const [selEmployee, setSelEmployee] = useState('');
  const [month,       setMonth]       = useState(new Date().getMonth() + 1);
  const [year,        setYear]        = useState(new Date().getFullYear());
  // What-if inputs start EMPTY: an empty field means "use the real figure"
  // (attendance, bonus plans, loans). They used to start at 0 and were always
  // sent, so every preview showed no absence, no bonus and no loan recovery.
  const [lopDays,     setLop]         = useState('');
  const [bonus,       setBonus]       = useState('');
  const [loanDed,     setLoanDed]     = useState('');
  const [advDed,      setAdvDed]      = useState('');
  const [slip,        setSlip]        = useState(null);
  const [pdfData,     setPdfData]     = useState(null);
  const [computing,   setComputing]   = useState(false);
  const [emailing,    setEmailing]    = useState(false);
  const [bulkEmail,   setBulkEmail]   = useState(EMPTY_BULK);
  const [msg,         setMsg]         = useState({ text: '', type: '' });
  const [cycle,       setCycle]       = useState(null);

  const slipRef       = useRef(null);
  const bulkAbortRef  = useRef(false);
  const computeIdRef  = useRef(0);
  const flashTimerRef = useRef(null);

  /* pay cycle for the selected month (server: /payroll/cycle).
     "Overdue" = the PAY date has passed and payroll is not approved/paid.
     It used to compare today with the attendance CUTOFF, so with cutoff 29
     September became "overdue" on the 30th although pay day was the 25th. */
  const payrollOverdue = cycle?.state === 'overdue' || cycle?.state === 'approved_unpaid_overdue';
  const payrollDueSoon = cycle?.state === 'cutoff_passed';
  const finalised      = cycle?.run_status === 'approved' || cycle?.run_status === 'paid';

  /* ── flash ── */
  const flash = useCallback((text, type = 'success') => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setMsg({ text, type });
    flashTimerRef.current = setTimeout(() => setMsg({ text: '', type: '' }), 5000);
  }, []);

  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);

  /* ── load employees once on mount ── */
  const loadEmployees = useCallback(async () => {
    setLoadingEmps(true);
    try {
      const r = await api.get('/employees');
      if (Array.isArray(r.data)) {
        const list = r.data.filter(e => !EX_STATUSES.has((e.status || '').toLowerCase()));
        setEmployees(list);
        setSelEmployee(prev => prev || (list.length ? String(list[0].id) : ''));
      }
    } catch {
      flash('Could not load employees — please refresh.', 'error');
    } finally {
      setLoadingEmps(false);
    }
  }, [flash]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  /* ── pay cycle + run status for the selected month ── */
  useEffect(() => {
    let live = true;
    setCycle(null);
    api.get('/payroll/cycle', { params: { month, year } })
      .then(r => { if (live) setCycle(r.data?.data || null); })
      .catch(() => {});
    return () => { live = false; };
  }, [month, year]);

  /* ── clear stale slip when params change ── */
  useEffect(() => { setSlip(null); setPdfData(null); }, [selEmployee, month, year]);

  /* ── filtered employee list ── */
  const filteredEmps = useMemo(() => {
    if (!empSearch.trim()) return employees;
    const q = empSearch.toLowerCase();
    return employees.filter(e =>
      empDisplayName(e).toLowerCase().includes(q) ||
      (e.office_id  || '').toLowerCase().includes(q) ||
      (e.department || '').toLowerCase().includes(q)
    );
  }, [employees, empSearch]);

  const selectedEmp = useMemo(
    () => employees.find(e => String(e.id) === selEmployee) || null,
    [employees, selEmployee]
  );

  /* ── compute payslip ── */
  const compute = async () => {
    if (!selEmployee) return flash('Select an employee first.', 'error');
    const reqId = ++computeIdRef.current;
    setComputing(true);
    setSlip(null);
    setPdfData(null);
    try {
      const payload = { employee_id: parseInt(selEmployee, 10), month, year };
      for (const [k, v] of [['lop_days', lopDays], ['bonus', bonus], ['loan_deduction', loanDed], ['advance_deduction', advDed]]) {
        if (String(v).trim() !== '') payload[k] = parseFloat(v) || 0;
      }
      const res = await api.post('/payroll/compute-slip', payload);
      if (reqId !== computeIdRef.current) return;
      setSlip(res.data);
      const pdfRes = await api.post(`/payroll/generate-pdf-data/${selEmployee}`, payload).catch(() => null);
      if (reqId !== computeIdRef.current) return;
      if (pdfRes?.data) {
        setPdfData(pdfRes.data);
      } else {
        flash('Payslip computed. PDF preview unavailable — download via button still works.', 'warning');
      }
    } catch (err) {
      if (reqId !== computeIdRef.current) return;
      const reasons = err.response?.data?.reasons;
      flash(reasons?.length
        ? `Not payable for ${MONTHS[month - 1]} ${year}: ${reasons.map(r => r.message).join('; ')}`
        : (err.response?.data?.error || err.message || 'Failed to compute payslip.'), 'error');
    } finally {
      if (reqId === computeIdRef.current) setComputing(false);
    }
  };

  /* ── print / download / email ── */
  const printPayslip = () => window.print();

  // The one payslip PDF (server): approved months are the issued payslip; a draft
  // or preview carries its watermark. What-if values are a screen preview only.
  const whatIf = [lopDays, bonus, loanDed, advDed].some(v => String(v).trim() !== '');
  const downloadPDF = async () => {
    try {
      const r = await api.get(`/payroll/payslip-pdf/${selEmployee}`, { params: { month, year }, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `Payslip_${pdfData?.employee?.code || selEmployee}_${MONTHS[month - 1]}_${year}.pdf`; a.click();
      URL.revokeObjectURL(url);
      flash('PDF downloaded.');
    } catch { flash('PDF download failed — please try again.', 'error'); }
  };

  const emailPayslip = async () => {
    if (!slip) return;
    setEmailing(true);
    try {
      const res = await api.post('/payroll/email-payslip', {
        employee_id: parseInt(selEmployee, 10), month, year,
      });
      flash(res.data.message || 'Payslip emailed to employee.');
    } catch (err) {
      flash(err.response?.data?.error || 'Email failed.', 'error');
    } finally {
      setEmailing(false);
    }
  };

  /* ── bulk email ── */
  const openBulkEmail = async () => {
    if (!finalised) return flash(`Bulk email is available only after ${MONTHS[month - 1]} ${year} payroll is approved in Run Payroll.`, 'error');
    let released = [];
    try {
      const r = await api.get('/payroll', { params: { month, year, limit: 500 } });
      released = (r.data?.data || []).filter(p => p.status === 'approved' || p.status === 'paid');
    } catch { return flash('Could not load the approved payroll for this month.', 'error'); }
    // Everyone with an approved payslip — including people who have since resigned
    // or are serving notice (they were left out when the list came from the
    // active-employee picker).
    if (!released.length) return flash('No approved payslips for this month.', 'error');
    const byId = new Map(employees.map(e => [e.id, e]));
    const rows = released.map(p => ({
      id: p.employee_id,
      name: p.name || empDisplayName(byId.get(p.employee_id) || {}),
      dept: p.department || '—',
      status: 'queued',
      error: null,
      sent_to: byId.get(p.employee_id)?.company_email || byId.get(p.employee_id)?.personal_email || null,
    }));
    bulkAbortRef.current = false;
    setBulkEmail({ show: true, active: false, rows, sent: 0, failed: 0 });
  };

  const startBulkEmail = async (retryOnly = false) => {
    bulkAbortRef.current = false;
    const prevSent  = retryOnly ? bulkEmail.sent : 0;
    const toProcess = retryOnly
      ? bulkEmail.rows.filter(r => r.status === 'failed')
      : bulkEmail.rows;

    setBulkEmail(prev => ({
      ...prev,
      active: true,
      sent:   prevSent,
      failed: 0,
      rows: prev.rows.map(r =>
        (!retryOnly || r.status === 'failed') ? { ...r, status: 'queued', error: null } : r
      ),
    }));

    let sent   = prevSent;
    let failed = 0;

    for (let i = 0; i < toProcess.length; i += BULK_BATCH_SIZE) {
      if (bulkAbortRef.current) break;
      const batch = toProcess.slice(i, i + BULK_BATCH_SIZE);

      setBulkEmail(prev => ({
        ...prev,
        rows: prev.rows.map(r =>
          batch.some(b => b.id === r.id) ? { ...r, status: 'sending' } : r
        ),
      }));

      const results = await Promise.allSettled(
        batch.map(emp =>
          api.post('/payroll/email-payslip', { employee_id: emp.id, month, year })
        )
      );

      results.forEach((result, bi) => {
        const empId = batch[bi].id;
        if (result.status === 'fulfilled') {
          sent++;
          const sentTo = result.value.data?.sent_to;
          setBulkEmail(prev => ({
            ...prev,
            sent,
            rows: prev.rows.map(r =>
              r.id === empId ? { ...r, status: 'sent', sent_to: sentTo || r.sent_to } : r
            ),
          }));
        } else {
          failed++;
          const errMsg = result.reason?.response?.data?.error || result.reason?.message || 'Failed';
          setBulkEmail(prev => ({
            ...prev,
            failed,
            rows: prev.rows.map(r =>
              r.id === empId ? { ...r, status: 'failed', error: errMsg } : r
            ),
          }));
        }
      });
    }

    setBulkEmail(prev => ({ ...prev, active: false }));
    const newlySent = sent - prevSent;
    flash(
      retryOnly
        ? `Retry done: ${newlySent} sent, ${failed} still failed.`
        : `Bulk email done: ${sent} sent, ${failed} failed.`,
      failed > 0 ? 'error' : 'success'
    );
  };

  const stopBulkEmail  = () => { bulkAbortRef.current = true; };
  const closeBulkEmail = () => { if (!bulkEmail.active) setBulkEmail(EMPTY_BULK); };

  const total    = bulkEmail.rows.length;
  const done     = bulkEmail.sent + bulkEmail.failed;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const hasFailed = bulkEmail.rows.some(r => r.status === 'failed');

  /* ── render ─────────────────────────────────────────────────────────────── */
  return (
    <PageShell embedded={embedded} dock={embedded ? null :
      <PageHero
        icon={Wallet}
        eyebrow="Human Resources"
        title="Payslip Generator"
        subtitle="Compute, preview and distribute payslips with full statutory breakup"
      />
    }>
      <style>{PRINT_CSS}</style>

      {/* Header */}


      <div style={bannerStyle('warning')}>
        <strong>Preview only.</strong> This screen computes a payslip with the same inputs as Run Payroll
        (salary revision, structure, Payroll Settings, attendance, loans) and saves nothing. The official
        payslip is created by <strong>Payroll Center → Payroll Processing</strong> and is issued only after approval.
        {cycle && <> {MONTHS[month - 1]} {year} payroll: <strong>{cycle.run_status || 'not generated'}</strong>.</>}
      </div>

      {/* Deadline banners — keyed off the configured PAY date */}
      {payrollOverdue && (
        <div style={bannerStyle('error')}>
          Payroll overdue — {MONTHS[month - 1]} {year} salary was due on {cycle.pay_date} and the payroll is
          {cycle.run_status === 'approved' ? ' approved but not paid.' : ' not approved.'}
        </div>
      )}
      {payrollDueSoon && (
        <div style={bannerStyle('warning')}>
          Attendance cutoff ({cycle.attendance_cutoff_date}) has passed — generate and approve {MONTHS[month - 1]} {year} payroll
          before the pay date, {cycle.pay_date}.
        </div>
      )}
      {cycle?.errors?.length > 0 && (
        <div style={bannerStyle('error')}>Pay cycle configuration: {cycle.errors.join(' ')}</div>
      )}

      {/* Flash message */}
      {msg.text && (
        <div style={{
          marginBottom: 12, padding: '10px 16px', borderRadius: 8,
          fontWeight: 500, fontSize: 14,
          ...(MSG_STYLE[msg.type] || MSG_STYLE.success),
        }}>
          {msg.text}
        </div>
      )}

      {/* ── Controls ── */}
      <div style={cardStyle}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14, marginBottom: 16 }}>

          {/* Employee picker with search */}
          <div style={{ gridColumn: 'span 2' }}>
            <label style={lblStyle}>
              Employee
              <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 8, fontSize: 11 }}>
                {loadingEmps ? 'Loading…' : `${employees.length} active`}
              </span>
            </label>
            <input
              type="search"
              placeholder="Filter by name, ID or department…"
              value={empSearch}
              onChange={e => setEmpSearch(e.target.value)}
              style={{ ...inputStyle, marginBottom: 5 }}
              disabled={computing || loadingEmps}
              aria-label="Search employees"
            />
            <select
              value={selEmployee}
              onChange={e => { setSelEmployee(e.target.value); setEmpSearch(''); }}
              style={selStyle}
              disabled={computing || loadingEmps}
              aria-label="Select employee"
            >
              {loadingEmps && <option disabled value="">Loading employees…</option>}
              {!loadingEmps && filteredEmps.length === 0 && (
                <option disabled value="">No employees match</option>
              )}
              {filteredEmps.map(e => (
                <option key={e.id} value={e.id}>
                  {e.office_id ? `[${e.office_id}] ` : ''}{empDisplayName(e)}
                  {e.department ? ` — ${e.department}` : ''}
                </option>
              ))}
            </select>
            {selectedEmp && (
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 5, paddingLeft: 2 }}>
                {[selectedEmp.office_id, selectedEmp.designation, selectedEmp.department, selectedEmp.status]
                  .filter(Boolean).join(' · ')}
              </div>
            )}
          </div>

          {/* Month */}
          <div>
            <label style={lblStyle}>Month</label>
            <select
              value={month}
              onChange={e => setMonth(parseInt(e.target.value, 10))}
              style={selStyle}
              disabled={computing}
            >
              {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
          </div>

          {/* Year — dynamic range */}
          <div>
            <label style={lblStyle}>Year</label>
            <select
              value={year}
              onChange={e => setYear(parseInt(e.target.value, 10))}
              style={selStyle}
              disabled={computing}
            >
              {yearRange().map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {/* Adjustments */}
          <div>
            <label style={lblStyle}>LOP Days</label>
            <input
              type="number" min={0} max={31} step={0.5}
              value={lopDays} onChange={e => setLop(e.target.value)} placeholder="from attendance"
              style={inputStyle} disabled={computing}
            />
          </div>
          <div>
            <label style={lblStyle}>Bonus (₹)</label>
            <input
              type="number" min={0}
              value={bonus} onChange={e => setBonus(e.target.value)} placeholder="from bonus plans"
              style={inputStyle} disabled={computing}
            />
          </div>
          <div>
            <label style={lblStyle}>Loan Deduction (₹)</label>
            <input
              type="number" min={0}
              value={loanDed} onChange={e => setLoanDed(e.target.value)} placeholder="from loans"
              style={inputStyle} disabled={computing}
            />
          </div>
          <div>
            <label style={lblStyle}>Advance Deduction (₹)</label>
            <input
              type="number" min={0}
              value={advDed} onChange={e => setAdvDed(e.target.value)} placeholder="from advances"
              style={inputStyle} disabled={computing}
            />
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={compute}
            disabled={computing || loadingEmps || !selEmployee}
            style={btnStyle('#6B3FDB')}
            aria-label="Compute payslip"
          >
            {computing ? 'Computing…' : 'Preview Payslip'}
          </button>

          {slip && (
            <>
              <button
                onClick={downloadPDF}
                disabled={whatIf}
                title={whatIf ? 'Clear the what-if fields: the PDF is the payslip itself, not a what-if' : 'Download the payslip PDF'}
                style={{ ...btnStyle('#16a34a'), opacity: whatIf ? 0.45 : 1 }}
                aria-label="Download as PDF"
              >
                Download PDF
              </button>
              <button
                onClick={printPayslip}
                style={btnStyle('#2563eb')}
                aria-label="Print payslip"
              >
                Print
              </button>
              <button
                onClick={emailPayslip}
                disabled={emailing || !['approved', 'paid'].includes(slip.run_status)}
                title={['approved', 'paid'].includes(slip.run_status) ? 'Email the approved payslip' : 'Only an approved payslip can be emailed'}
                style={{ ...btnStyle('#0891b2'), opacity: ['approved', 'paid'].includes(slip.run_status) ? 1 : 0.45 }}
                aria-label="Email payslip to employee"
              >
                {emailing ? 'Sending…' : 'Email Payslip'}
              </button>
            </>
          )}

          <div style={{ marginLeft: 'auto' }}>
            <button
              onClick={openBulkEmail}
              disabled={!finalised}
              title={finalised ? 'Email every approved payslip for this month' : 'Available after this month\'s payroll is approved'}
              style={{ ...btnStyle('#6d28d9'), opacity: finalised ? 1 : 0.45 }}
              aria-label={`Bulk email payslips for ${MONTHS[month - 1]} ${year}`}
            >
              Bulk Email — {MONTHS[month - 1]} {year}
            </button>
          </div>
        </div>
        {/* The disabled reasons used to live only in hover titles. */}
        {(!finalised || (slip && !['approved', 'paid'].includes(slip.run_status))) && (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: '#92400e' }}>
            <strong>Emailing is unavailable:</strong>{' '}
            {!finalised
              ? <>{MONTHS[month - 1]} {year} payroll is {cycle?.run_status ? `"${cycle.run_status}"` : 'not generated'} — payslips
                can be emailed only after the month is approved in Payroll Processing. Until then this screen is a preview.</>
              : <>this employee's payslip is {slip.run_status ? `"${slip.run_status}"` : 'not generated'}, not approved — only an
                approved payslip can be emailed. Bulk Email sends the approved ones.</>}
          </p>
        )}
      </div>

      {/* ── Bulk Email Panel ── */}
      {bulkEmail.show && (
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div>
              <h4 style={{ margin: 0, color: '#4c1d95', fontSize: 15, fontWeight: 700 }}>
                Bulk Email Payslips — {MONTHS[month - 1]} {year}
              </h4>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>
                {total} employees · {bulkEmail.sent} sent · {bulkEmail.failed} failed
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {!bulkEmail.active && done === 0 && (
                <button onClick={() => startBulkEmail(false)} style={btnStyle('#16a34a', '9px 16px')}>
                  Start Sending
                </button>
              )}
              {!bulkEmail.active && hasFailed && (
                <button onClick={() => startBulkEmail(true)} style={btnStyle('#6B3FDB', '9px 16px')}>
                  Retry Failed ({bulkEmail.failed})
                </button>
              )}
              {!bulkEmail.active && done > 0 && (
                <button onClick={() => startBulkEmail(false)} style={btnStyle('#6b7280', '9px 16px')}>
                  Send All Again
                </button>
              )}
              {bulkEmail.active && (
                <button onClick={stopBulkEmail} style={btnStyle('#dc2626', '9px 16px')}>
                  Stop
                </button>
              )}
              <button
                onClick={closeBulkEmail}
                disabled={bulkEmail.active}
                style={{ ...btnStyle('#6b7280', '9px 16px'), opacity: bulkEmail.active ? 0.4 : 1 }}
                aria-label="Close bulk email panel"
              >
                Close
              </button>
            </div>
          </div>

          {/* Progress */}
          {total > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                <span>{done} / {total} processed</span>
                <span style={{ fontWeight: 700 }}>{progress}%</span>
              </div>
              <div style={{ height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${progress}%`,
                  background: bulkEmail.failed > 0 && done === total ? '#ef4444' : '#6B3FDB',
                  borderRadius: 4,
                  transition: 'width 0.25s ease',
                }} />
              </div>
              {bulkEmail.sent > 0 && (
                <div style={{ height: 4, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden', marginTop: 2 }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.round((bulkEmail.sent / total) * 100)}%`,
                    background: '#16a34a',
                    borderRadius: 4,
                    transition: 'width 0.25s ease',
                  }} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11 }}>
                <span style={{ color: '#16a34a', fontWeight: 600 }}>{bulkEmail.sent} sent</span>
                {bulkEmail.failed > 0 && (
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>{bulkEmail.failed} failed</span>
                )}
                {done < total && bulkEmail.active && (
                  <span style={{ color: '#6B3FDB' }}>Sending…</span>
                )}
              </div>
            </div>
          )}

          {/* Per-employee table */}
          <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid #f3f4f6', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#f5f3ff', zIndex: 1 }}>
                <tr>
                  <th style={thStyle}>Employee</th>
                  <th style={thStyle}>Department</th>
                  <th style={thStyle}>Send To</th>
                  <th style={{ ...thStyle, width: 180 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {bulkEmail.rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{r.name}</td>
                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{r.dept}</td>
                    <td style={{ padding: '8px 12px', fontSize: 11, color: '#6b7280' }}>
                      {r.sent_to || '—'}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ color: STATUS_COLOR[r.status], fontWeight: 600, fontSize: 12 }}>
                        {STATUS_ICON[r.status]}{' '}
                        {r.status === 'failed' ? (
                          <span title={r.error} style={{ cursor: 'help' }}>
                            Failed{r.error ? ` — ${r.error.slice(0, 40)}` : ''}
                          </span>
                        ) : (
                          { queued: 'Queued', sending: 'Sending…', sent: 'Sent' }[r.status]
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Payslip Preview ── */}
      {pdfData && (
        <div
          id="payslip-preview"
          ref={slipRef}
          style={{
            background: '#fff',
            border: '2px solid #e9e4ff',
            borderRadius: 12,
            padding: 32,
            maxWidth: 800,
            margin: '0 auto',
            fontFamily: 'Arial, sans-serif',
          }}
        >
          {/* Company header */}
          <div style={{ textAlign: 'center', borderBottom: '2px solid #6B3FDB', paddingBottom: 16, marginBottom: 16 }}>
            <div style={{
              width: 60, height: 60, background: '#ede9fe', borderRadius: 10,
              margin: '0 auto 8px', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 24,
            }}>
              🏭
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#4c1d95' }}>{pdfData.company.name}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{pdfData.company.address}</div>
            {pdfData.company.gstin && (
              <div style={{ fontSize: 12, color: '#6b7280' }}>GSTIN: {pdfData.company.gstin}</div>
            )}
            <div style={{ fontSize: 16, fontWeight: 700, color: '#6B3FDB', marginTop: 8 }}>
              PAYSLIP FOR {pdfData.period.period_label.toUpperCase()}
            </div>
            {pdfData.watermark && (
              <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626', marginTop: 4 }}>{pdfData.watermark}</div>
            )}
          </div>

          {/* Employee details */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 20, fontSize: 13 }}>
            {[
              ['Employee Name', pdfData.employee.name],
              ['Employee Code', pdfData.employee.code],
              ['Designation',   pdfData.employee.designation],
              ['Department',    pdfData.employee.department],
              ['PAN Number',    pdfData.employee.pan],
              ['Bank A/C',      pdfData.employee.bank_account],
              ['Days paid',     pdfData.period.paid_days != null && pdfData.period.paid_days !== '—' ? `${pdfData.period.paid_days}${pdfData.period.days_in_month && pdfData.period.days_in_month !== '—' ? ` of ${pdfData.period.days_in_month}` : ''}` : '—'],
              ['LOP Days',      pdfData.period.lop_days],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
                <span style={{ color: '#6b7280', minWidth: 130, fontWeight: 500 }}>{k}:</span>
                <span style={{ fontWeight: 600 }}>{v ?? '—'}</span>
              </div>
            ))}
          </div>

          {/* Earnings / Deductions */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            {/* Earnings */}
            <div>
              <div style={tableTitleStyle('#4c1d95')}>EARNINGS</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f5f3ff' }}>
                    <th style={colHStyle('#4c1d95', 'left')}>Component</th>
                    <th style={colHStyle('#4c1d95', 'right')}>Monthly</th>
                  </tr>
                </thead>
                <tbody>
                  {pdfData.earnings.map((e, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                      <td style={tdL}>{e.name}</td>
                      <td style={{ ...tdR, fontWeight: 500 }}>{fmtINR(e.monthly)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#f5f3ff', fontWeight: 700 }}>
                    <td style={{ ...tdL, color: '#4c1d95' }}>Gross</td>
                    <td style={{ ...tdR, color: '#16a34a' }}>{fmtINR(pdfData.gross)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Deductions */}
            <div>
              <div style={tableTitleStyle('#dc2626')}>DEDUCTIONS</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fef2f2' }}>
                    <th style={colHStyle('#dc2626', 'left')}>Component</th>
                    <th style={colHStyle('#dc2626', 'right')}>Monthly</th>
                  </tr>
                </thead>
                <tbody>
                  {pdfData.deductions.map((d, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #fef2f2' }}>
                      <td style={tdL}>{d.name}</td>
                      <td style={{ ...tdR, color: '#dc2626', fontWeight: 500 }}>{fmtINR(d.monthly)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#fef2f2', fontWeight: 700 }}>
                    <td style={{ ...tdL, color: '#dc2626' }}>Total Deductions</td>
                    <td style={{ ...tdR, color: '#dc2626' }}>{fmtINR(pdfData.total_deductions)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {(pdfData.lop_note || pdfData.taxable_perquisites?.length > 0) && (
            <div style={{ fontSize: 12, color: '#4b5563', marginBottom: 12 }}>
              {pdfData.lop_note && <div>Loss of pay {pdfData.lop_note}.</div>}
              {(pdfData.taxable_perquisites || []).map(p => <div key={p.name}>{p.name}: {fmtINR(p.monthly)}</div>)}
            </div>
          )}
          {pdfData.employer_contributions?.length > 0 && (
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13 }}>
              <div style={{ fontWeight: 700, color: '#374151', marginBottom: 6 }}>
                EMPLOYER CONTRIBUTIONS <span style={{ fontWeight: 400, color: '#6b7280' }}>— employer cost, not deducted from pay</span>
              </div>
              {pdfData.employer_contributions.map((c, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                  <span style={{ color: '#6b7280' }}>{c.name}</span><span>{fmtINR(c.monthly)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Net pay */}
          <div style={{
            background: 'linear-gradient(135deg,#6B3FDB,#4c1d95)',
            borderRadius: 12, padding: 20, textAlign: 'center', marginBottom: 20, color: '#fff',
          }}>
            <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>
              NET PAY FOR {pdfData.period.period_label.toUpperCase()}
            </div>
            <div style={{ fontSize: 36, fontWeight: 900 }}>{fmtINR(pdfData.net_pay)}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
              ({numWords(Math.round(pdfData.net_pay))} Rupees Only)
            </div>
          </div>

          {/* Form 16 summary */}
          {pdfData.form16_summary && (
            <div style={{ background: '#f5f3ff', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 12 }}>
              <div style={{ fontWeight: 700, color: '#4c1d95', marginBottom: 8 }}>
                Form 16 Summary (Indicative)
              </div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <span>Tax Regime: <strong>{pdfData.form16_summary.tax_regime?.toUpperCase()}</strong></span>
                <span>Annual Taxable Income: <strong>{fmtINR(pdfData.form16_summary.annual_taxable_income)}</strong></span>
                <span>Annual Tax Liability: <strong>{fmtINR(pdfData.form16_summary.annual_tax)}</strong></span>
              </div>
            </div>
          )}

          {/* Footer */}
          <div style={{ fontSize: 11, color: '#6b7280', borderTop: '1px solid #e9e4ff', paddingTop: 12, textAlign: 'center' }}>
            This is a system-generated payslip and does not require a physical signature.
            {pdfData.company.support_email
              ? ` For queries, contact ${pdfData.company.support_email}.`
              : ' Contact your HR department for queries.'}
          </div>

          {/* Signature lines */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 24, paddingTop: 20, borderTop: '1px solid #e9e4ff' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ borderBottom: '1px solid #374151', marginBottom: 6, height: 30 }} />
              <div style={{ fontSize: 12, color: '#6b7280' }}>Employee Signature</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ borderBottom: '1px solid #374151', marginBottom: 6, height: 30 }} />
              <div style={{ fontSize: 12, color: '#6b7280' }}>Authorised Signatory</div>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!pdfData && !computing && (
        <div style={{ textAlign: 'center', padding: '60px 24px', color: '#9ca3af' }}>
          <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.35 }}>🧾</div>
          <p style={{ margin: 0, fontSize: 14 }}>
            {!loadingEmps && employees.length === 0
              ? 'No active employees found.'
              : slip
              ? 'Payslip computed — PDF preview loading.'
              : 'Select an employee and month, then click Compute Payslip.'}
          </p>
        </div>
      )}
    </PageShell>
  );
}

/* ── style helpers ────────────────────────────────────────────────────────── */

const cardStyle = {
  background: '#fff',
  border: '1px solid #e9e4ff',
  borderRadius: 12,
  padding: 20,
  marginBottom: 20,
};

const lblStyle = {
  fontSize: 12,
  fontWeight: 600,
  color: '#4c1d95',
  display: 'block',
  marginBottom: 4,
};

const selStyle = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #e9e4ff',
  borderRadius: 7,
  fontSize: 13,
  background: '#fff',
};

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  border: '1px solid #e9e4ff',
  borderRadius: 7,
  fontSize: 13,
};

const btnStyle = (bg, pad = '9px 20px') => ({
  background: bg,
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: pad,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: 'nowrap',
});

const thStyle = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 700,
  color: '#4c1d95',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '1px solid #e9e4ff',
};

const tdL = { padding: '6px 10px' };
const tdR = { padding: '6px 10px', textAlign: 'right' };

const tableTitleStyle = bg => ({
  background: bg,
  color: '#fff',
  padding: '8px 12px',
  borderRadius: '8px 8px 0 0',
  fontWeight: 700,
  fontSize: 13,
});

const colHStyle = (color, align) => ({
  padding: '6px 10px',
  textAlign: align,
  borderBottom: `1px solid ${color === '#4c1d95' ? '#e9e4ff' : '#fecaca'}`,
  color,
  background: color === '#4c1d95' ? '#f5f3ff' : '#fef2f2',
});

function bannerStyle(variant) {
  const map = {
    error:   { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' },
    warning: { background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe' },
  };
  return {
    marginBottom: 12,
    padding: '12px 16px',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    ...map[variant],
  };
}
