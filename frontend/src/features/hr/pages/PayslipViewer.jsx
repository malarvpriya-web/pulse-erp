import { useState, useEffect, useCallback, useMemo } from 'react';
import { Printer, Download, ChevronLeft, ChevronRight, Mail, MessageCircle } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './PayslipViewer.print.css';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const safeNum = (n) => Number(n || 0);

/**
 * @param {Function} setPage - navigate to another page key
 */
export default function PayslipViewer({ setPage: _setPage }) {
  const { user } = useAuth();
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

  const resolvedEmployee = useMemo(() => {
    if (selectedEmployee?.id) return selectedEmployee;
    const userId = user?.employee_id || null;
    if (!userId) return null;
    return {
      id: userId,
      name: user?.name || user?.full_name || user?.email || 'Employee',
      designation: user?.designation || '',
      department: user?.department || '',
    };
  }, [selectedEmployee, user]);

  // Build a rolling 12-month list (current month going back 11 months).
  // Payslips are computed on-the-fly for any month, so every month in this
  // window is always "available". No API call needed here.
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
      setError('No employee context found. Please open from self-service or select an employee first.');
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
      setError(err.message || 'Failed to load payslip');
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
  const netPay = totalEarnings - totalDeductions;
  const fmt = (n) => `₹${safeNum(n).toLocaleString('en-IN')}`;

  const displayName = data?.employee?.name || resolvedEmployee?.name || 'Employee';
  const employeeInfo = {
    id: data?.employee?.id || resolvedEmployee?.id || '-',
    designation: data?.employee?.designation || resolvedEmployee?.designation || '-',
    department: data?.employee?.department || resolvedEmployee?.department || '-',
    pan: data?.employee?.pan || '-',
    bank: data?.employee?.bank || '-',
    dob: data?.employee?.dob || resolvedEmployee?.dob || null,
    email: data?.employee?.email || resolvedEmployee?.email || user?.email || null,
    phone: data?.employee?.phone || resolvedEmployee?.phone || user?.phone || null,
  };

  const handlePrint = () => window.print();

  const handleDownloadPdf = async () => {
    if (!data) return;
    setPdfBusy(true);
    try {
      const { jsPDF } = await import('jspdf');
      const dobPassword = employeeInfo.dob
        ? String(employeeInfo.dob).replaceAll('-', '')
        : null;
      const doc = new jsPDF({
        encryption: dobPassword
          ? {
              userPassword: dobPassword,
              ownerPassword: dobPassword,
              userPermissions: ['print'],
            }
          : undefined,
      });
      doc.setFontSize(16);
      doc.text('Manifest Technologies - Payslip', 14, 16);
      doc.setFontSize(11);
      doc.text(`${MONTHS[month]} ${year}`, 14, 24);
      doc.text(`Employee: ${displayName}`, 14, 32);
      doc.text(`Employee ID: ${employeeInfo.id}`, 14, 38);
      doc.text(`Designation: ${employeeInfo.designation}`, 14, 44);
      doc.text(`Department: ${employeeInfo.department}`, 14, 50);

      let y = 60;
      doc.text('Earnings', 14, y); y += 6;
      (data.earnings || []).forEach((e) => { doc.text(`${e.label}: ${fmt(e.amount)}`, 14, y); y += 6; });
      y += 4;
      doc.text(`Total Earnings: ${fmt(totalEarnings)}`, 14, y);
      y += 10;
      doc.text('Deductions', 14, y); y += 6;
      (data.deductions || []).forEach((d) => { doc.text(`${d.label}: ${fmt(d.amount)}`, 14, y); y += 6; });
      y += 4;
      doc.text(`Total Deductions: ${fmt(totalDeductions)}`, 14, y);
      y += 10;
      doc.setFontSize(13);
      doc.text(`Net Pay: ${fmt(netPay)}`, 14, y);
      if (dobPassword) {
        y += 10;
        doc.setFontSize(9);
        doc.text('Password: Your DOB in YYYYMMDD format', 14, y);
      }
      doc.save(`Payslip_${employeeInfo.id}_${year}_${String(month + 1).padStart(2, '0')}.pdf`);
    } catch {
      setError('PDF generation failed. Please try again.');
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
        email: employeeInfo.email,
      });
      setNotice('Payslip emailed successfully.');
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

  return (
    <div style={{ padding: '24px' }}>
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

      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700 }}>Payslip Viewer</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: '13px' }}>{displayName}</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button onClick={handlePrint} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#f3f4f6', border: 'none', borderRadius: '8px', padding: '8px 14px', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>
            <Printer size={14} /> Print
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={!data || pdfBusy}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', background: '#6366f1', color: '#fff', border: 'none',
              borderRadius: '8px', padding: '8px 14px', fontWeight: 600, fontSize: '13px',
              cursor: !data || pdfBusy ? 'not-allowed' : 'pointer', opacity: !data || pdfBusy ? 0.6 : 1,
            }}
          >
            <Download size={14} /> {pdfBusy ? 'Preparing PDF...' : 'Download PDF'}
          </button>
          {employeeInfo.dob && (
            <div style={{ alignSelf: 'center', fontSize: '11px', color: '#6b7280', marginLeft: '2px' }}>
              PDF password: DOB YYYYMMDD
            </div>
          )}
          <button
            onClick={handleEmailSelf}
            disabled={!data || emailBusy}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', background: '#1f2937', color: '#fff', border: 'none',
              borderRadius: '8px', padding: '8px 14px', fontWeight: 600, fontSize: '13px',
              cursor: !data || emailBusy ? 'not-allowed' : 'pointer', opacity: !data || emailBusy ? 0.6 : 1,
            }}
          >
            <Mail size={14} /> {emailBusy ? 'Emailing...' : 'Email My Payslip'}
          </button>
          <button
            onClick={handleWhatsAppShare}
            disabled={!data || waBusy}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', background: '#16a34a', color: '#fff', border: 'none',
              borderRadius: '8px', padding: '8px 14px', fontWeight: 600, fontSize: '13px',
              cursor: !data || waBusy ? 'not-allowed' : 'pointer', opacity: !data || waBusy ? 0.6 : 1,
            }}
          >
            <MessageCircle size={14} /> {waBusy ? 'Sharing...' : 'WhatsApp Share'}
          </button>
        </div>
      </div>

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
                <div style={{ fontSize: '20px', fontWeight: 800 }}>Manifest Technologies</div>
                <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '4px' }}>Payslip for {MONTHS[month]} {year}</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: '13px', opacity: 0.9 }}>
                <div>Generated: {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div>
              </div>
            </div>
          </div>

          <div style={{ padding: '20px 24px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
            {[
              ['Employee Name', displayName],
              ['Employee ID', employeeInfo.id],
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
        </div>
      )}
    </div>
  );
}
