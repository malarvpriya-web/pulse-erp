import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Printer, Download, ChevronLeft, ChevronRight, Mail, MessageCircle,
  Wallet,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './PayslipViewer.print.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const safeNum = (n) => Number(n || 0);

/**
 * @param {Function} setPage - navigate to another page key
 */
export default function PayslipViewer({ setPage: _setPage, embedded = false }) {
  const { user, hasPermission } = useAuth();
  // HR / payroll can look up any employee here; everyone else sees their own.
  const canPick = typeof hasPermission === 'function' && hasPermission('payroll', 'view');
  const [people, setPeople] = useState([]);
  const [picked, setPicked] = useState(null);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [availableMonths, setAvailableMonths] = useState([]);
  const [payslip, setPayslip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [waBusy, setWaBusy] = useState(false);

  const selectedEmployee = (() => {
    try { return JSON.parse(sessionStorage.getItem('selectedEmployee') || '{}'); }
    catch { return {}; }
  })();

  useEffect(() => {
    if (!canPick) return;
    api.get('/employees').then(r => setPeople(Array.isArray(r.data) ? r.data : [])).catch(() => setPeople([]));
  }, [canPick]);

  const resolvedEmployee = useMemo(() => {
    if (picked) return picked;
    if (selectedEmployee?.id) return selectedEmployee;
    const userId = user?.employee_id || null;
    if (!userId) return null;
    return {
      id: userId,
      name: user?.name || user?.full_name || user?.email || 'Employee',
      designation: user?.designation || '',
      department: user?.department || '',
    };
  }, [picked, selectedEmployee, user]);

  // The last 12 months. A month with no released payslip says so when chosen.
  const fetchAvailableMonths = useCallback((_employeeId) => {
    const today = new Date();
    const list = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      list.push({ month: d.getMonth() + 1, year: d.getFullYear() });
    }
    setAvailableMonths(list);
    if (list.length > 0) {
      setMonth(list[0].month - 1);
      setYear(list[0].year);
    }
  }, []);

  const fetchPayslip = useCallback(async () => {
    if (!resolvedEmployee?.id) {
      setError(canPick ? 'Choose an employee above.' : 'No employee record is linked to your login, so there is no payslip to show.');
      setPayslip(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      const res = await api.get('/payroll/payslips', {
        params: { employee_id: resolvedEmployee.id, month: month + 1, year },
      });
      const payload = res.data?.data ?? res.data ?? null;
      if (!payload || (Array.isArray(payload) && payload.length === 0)) {
        setPayslip(null);
        setError(`No payslip found for ${MONTHS[month]} ${year}.`);
      } else {
        setPayslip(Array.isArray(payload) ? payload[0] : payload);
      }
    } catch (err) {
      setPayslip(null);
      // 404 = not released yet (self-service sees approved payslips only);
      // 422 = not payable, with the reason.
      const d = err?.response?.data;
      setError(d?.reasons?.length ? `${d.message}: ${d.reasons.map(r => r.message).join('; ')}` : (d?.message || err.message || 'Failed to load payslip'));
    } finally {
      setLoading(false);
    }
  }, [resolvedEmployee?.id, month, year]);

  useEffect(() => {
    if (resolvedEmployee?.id) fetchAvailableMonths(resolvedEmployee.id);
  }, [resolvedEmployee?.id, fetchAvailableMonths]);

  useEffect(() => { fetchPayslip(); }, [fetchPayslip]);

  const prevMonth = () => {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    const today = new Date();
    if (year > today.getFullYear() || (year === today.getFullYear() && month >= today.getMonth())) return;
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  };

  const data = payslip;
  const totalEarnings = (data?.earnings || []).reduce((a, e) => a + safeNum(e.amount), 0);
  const totalDeductions = (data?.deductions || []).reduce((a, d) => a + safeNum(d.amount), 0);
  const netPay = data?.net_pay != null ? safeNum(data.net_pay) : totalEarnings - totalDeductions;
  const fmt = (n) => `₹${safeNum(n).toLocaleString('en-IN')}`;

  const displayName = data?.employee?.name || resolvedEmployee?.name || 'Employee';
  const employeeInfo = {
    id: data?.employee_code || data?.employee?.code || resolvedEmployee?.office_id || '-',
    designation: data?.employee?.designation || resolvedEmployee?.designation || '-',
    department: data?.employee?.department || resolvedEmployee?.department || '-',
    pan: data?.employee?.pan || '-',
    bank: data?.employee?.bank || '-',
    dob: data?.employee?.dob || resolvedEmployee?.dob || null,
    email: data?.employee?.email || resolvedEmployee?.email || user?.email || null,
    phone: data?.employee?.phone || resolvedEmployee?.phone || user?.phone || null,
  };

  const handlePrint = () => window.print();

  const released = !!data && !data.preview && ['approved', 'paid'].includes(data.status);
  const companyName = data?.company?.name || '';

  const handleDownloadPdf = async () => {
    if (!data) return;
    setPdfBusy(true);
    try {
      const r = await api.get(`/payroll/payslip-pdf/${resolvedEmployee?.id}`, { params: { month: month + 1, year }, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `Payslip_${employeeInfo.id}_${year}_${String(month + 1).padStart(2, '0')}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('PDF download failed. Please try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleEmailSelf = async () => {
    if (!data) return;
    if (!employeeInfo.email) {
      setError('No email found for this employee.');
      return;
    }
    setEmailBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/payroll/email-payslip', {
        employee_id: resolvedEmployee?.id,
        month: month + 1,
        year,
      });
      setNotice('Payslip emailed to the address on the employee record.');
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to email payslip.');
    } finally {
      setEmailBusy(false);
    }
  };

  const handleWhatsAppShare = async () => {
    if (!data) return;
    if (!employeeInfo.phone) {
      setError('No phone number found for this employee.');
      return;
    }
    setWaBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/integrations/whatsapp/send', {
        to: employeeInfo.phone,
        template_name: 'payslip_ready',
        template_params: [displayName, `${MONTHS[month]} ${year}`],
      });
      setNotice('WhatsApp payslip notification sent.');
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to share payslip on WhatsApp.');
    } finally {
      setWaBusy(false);
    }
  };

  const actions = (
    <>
      <button className="plh-cta plh-cta--ghost" onClick={handlePrint}>
        <Printer size={14} /> Print
      </button>
      <button className="plh-cta plh-cta--ghost"
        onClick={handleDownloadPdf}
        disabled={!data || pdfBusy}>
        <Download size={14} /> {pdfBusy ? 'Preparing PDF...' : 'Download PDF'}
      </button>
      <button className="plh-cta plh-cta--ghost"
        onClick={handleEmailSelf}
        disabled={!released || emailBusy}
        title={released ? 'Email this payslip' : 'Only a released (approved) payslip can be sent'}>
        <Mail size={14} /> {emailBusy ? 'Emailing...' : 'Email payslip'}
      </button>
      <button className="plh-cta"
        onClick={handleWhatsAppShare}
        disabled={!released || waBusy}
        title={released ? 'Tell the employee the payslip is ready' : 'Only a released (approved) payslip can be shared'}>
        <MessageCircle size={14} /> {waBusy ? 'Sharing...' : 'WhatsApp Share'}
      </button>
    </>
  );

  return (
    <PageShell embedded={embedded} dock={embedded ? null :
      <PageHero
        icon={Wallet}
        eyebrow="Human Resources"
        title="Payslip Viewer"
        subtitle="Released payslips, month by month"
        actions={actions}
      />
    }>
      {embedded && (
        <div className="pc-toolbar no-print">
          <span className="pc-toolbar-who">
            {canPick ? (
              <label>Employee{' '}
                <select aria-label="Employee" value={resolvedEmployee?.id || ''} onChange={e => {
                  const p = people.find(x => String(x.id) === e.target.value);
                  if (p) setPicked({ id: p.id, name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), designation: p.designation, department: p.department, office_id: p.office_id });
                }} style={{ padding: '4px 8px', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                  {!resolvedEmployee?.id && <option value="">— choose —</option>}
                  {people.map(p => <option key={p.id} value={p.id}>{p.office_id ? `[${p.office_id}] ` : ''}{`${p.first_name || ''} ${p.last_name || ''}`.trim()}</option>)}
                </select>
              </label>
            ) : <>Showing <strong>{displayName}</strong> (your own payslip)</>}
          </span>
          <div className="pc-toolbar-actions">{actions}</div>
        </div>
      )}
      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '13px' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ background: '#dcfce7', color: '#166534', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '13px' }}>
          {notice}
        </div>
      )}

      {loading && (
        <div style={{ background: '#f3f4f6', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '13px', color: '#6b7280' }}>
          Loading payslip...
        </div>
      )}



      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px', background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', padding: '12px 20px', width: 'fit-content' }}>
        <button onClick={prevMonth} style={{ border: 'none', background: '#f3f4f6', borderRadius: '6px', padding: '5px', cursor: 'pointer' }}><ChevronLeft size={16} /></button>
        <span style={{ fontWeight: 700, fontSize: '15px', minWidth: '160px', textAlign: 'center' }}>{MONTHS[month]} {year}</span>
        <button onClick={nextMonth} style={{ border: 'none', background: '#f3f4f6', borderRadius: '6px', padding: '5px', cursor: 'pointer' }}><ChevronRight size={16} /></button>
        <select
          value={`${year}-${month + 1}`}
          onChange={(e) => {
            const [y, m] = e.target.value.split('-').map(Number);
            if (y && m) {
              setYear(y);
              setMonth(m - 1);
            }
          }}
          style={{ marginLeft: 10, border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 8px', fontSize: 12 }}
        >
          {availableMonths.length === 0 ? (
            <option value={`${year}-${month + 1}`}>No month list</option>
          ) : availableMonths.map((p) => (
            <option key={`${p.year}-${p.month}`} value={`${p.year}-${p.month}`}>
              {MONTHS[p.month - 1]} {p.year}
            </option>
          ))}
        </select>
      </div>

      {loading ? null : !data ? (
        <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', padding: '20px', maxWidth: '800px', color: '#6b7280' }}>
          No verified payslip data available for the selected period.
        </div>
      ) : (
        <div id="payslip-print" style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', overflow: 'hidden', maxWidth: '800px' }}>
          <div style={{ background: '#6366f1', color: '#fff', padding: '20px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '20px', fontWeight: 800 }}>{companyName}</div>
                <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '4px' }}>Payslip for {MONTHS[month]} {year}</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: '13px', opacity: 0.9 }}>
                {data.generated_at && <div>Prepared: {new Date(data.generated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div>}
                {data.days_in_month && <div>Days paid: {data.paid_days ?? data.days_in_month} of {data.days_in_month} · LOP {Number(data.lop_days || 0)}</div>}
              </div>
            </div>
          </div>

          <div style={{ padding: '20px 24px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
            {[
              ['Employee Name', displayName],
              ['Employee Code', employeeInfo.id],
              ['Designation', employeeInfo.designation],
              ['Department', employeeInfo.department],
              ['PAN Number', employeeInfo.pan],
              ['Bank Account', employeeInfo.bank],
            ].map(([label, val]) => (
              <div key={label}>
                <div style={{ fontSize: '11px', color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#111827', marginTop: '2px' }}>{val}</div>
              </div>
            ))}
          </div>

          <div style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: '#15803d', marginBottom: '12px', paddingBottom: '6px', borderBottom: '2px solid #dcfce7' }}>EARNINGS</div>
              {(data?.earnings || []).map((e) => (
                <div key={e.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px' }}>
                  <span style={{ color: '#374151' }}>{e.label}</span>
                  <span style={{ fontWeight: 600 }}>{fmt(e.amount)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #e5e7eb', fontSize: '14px', fontWeight: 700, color: '#15803d' }}>
                <span>Total Earnings</span><span>{fmt(totalEarnings)}</span>
              </div>
            </div>

            <div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: '#dc2626', marginBottom: '12px', paddingBottom: '6px', borderBottom: '2px solid #fee2e2' }}>DEDUCTIONS</div>
              {(data?.deductions || []).map((d) => (
                <div key={d.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px' }}>
                  <span style={{ color: '#374151' }}>{d.label}</span>
                  <span style={{ fontWeight: 600, color: d.amount > 0 ? '#111827' : '#9ca3af' }}>{d.amount > 0 ? fmt(d.amount) : '-'}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #e5e7eb', fontSize: '14px', fontWeight: 700, color: '#dc2626' }}>
                <span>Total Deductions</span><span>{fmt(totalDeductions)}</span>
              </div>
            </div>
          </div>

          <div style={{ margin: '0 24px 24px', background: '#6366f1', borderRadius: '10px', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#fff' }}>
            <span style={{ fontWeight: 700, fontSize: '16px' }}>Net Pay (Take Home)</span>
            <span style={{ fontWeight: 800, fontSize: '22px' }}>{fmt(netPay)}</span>
          </div>
          {(data?.lop_note || (data?.taxable_perquisites || []).length > 0) && (
            <div style={{ margin: '0 24px 16px', fontSize: '12px', color: '#4b5563' }}>
              {data.lop_note && <div>Loss of pay {data.lop_note}.</div>}
              {(data.taxable_perquisites || []).map(p => <div key={p.label}>{p.label}: {fmt(p.amount)}</div>)}
            </div>
          )}
          {(data?.employer_contributions_list || []).length > 0 && (
            <div style={{ margin: '0 24px 24px', fontSize: '13px' }}>
              <div style={{ fontWeight: 700, color: '#374151', marginBottom: '8px' }}>
                EMPLOYER CONTRIBUTIONS <span style={{ fontWeight: 400, color: '#6b7280' }}>— paid by the employer, not deducted from your pay</span>
              </div>
              {data.employer_contributions_list.map((c) => (
                <div key={c.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ color: '#6b7280' }}>{c.label}</span><span>{fmt(c.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {(data?.preview || (data?.status && !['approved', 'paid'].includes(data.status))) && (
            <div style={{ margin: '0 24px 24px', color: '#b45309', fontSize: '12px', fontWeight: 600 }}>
              {data.preview ? 'Preview — payroll has not been generated for this month.' : `Draft (${data.status}) — not an issued payslip until payroll is approved.`}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
