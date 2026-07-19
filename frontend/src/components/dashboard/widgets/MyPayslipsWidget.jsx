import { useState, useEffect } from 'react';
import { FileText, Download, Loader, AlertCircle } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';

const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');

function printPayslip(entry) {
  const s = entry.slip || {};
  const name = entry.employee_name || 'Employee';
  const period = entry.period_label;
  const dept = entry.department || '';
  const desig = entry.designation || '';

  const earnings = [
    ['Basic Salary',          s.basic              || 0],
    ['HRA',                   s.hra                || 0],
    ['Conveyance Allowance',  s.conveyance_allowance || 0],
    ['Medical Allowance',     s.medical_allowance  || 0],
    ['Special Allowance',     s.special_allowance  || 0],
  ].filter(([, v]) => v > 0);

  if (s.overtime_pay > 0) earnings.push(['Overtime Pay', s.overtime_pay]);
  if (s.bonus > 0)        earnings.push(['Bonus',        s.bonus]);

  const deductions = [
    ['Provident Fund',    s.employee_pf       || 0],
    ['ESI',               s.employee_esi      || 0],
    ['Professional Tax',  s.professional_tax  || 0],
    ['Income Tax (TDS)',  s.tds               || 0],
  ].filter(([, v]) => v > 0);

  const gross = s.gross || entry.gross_pay || 0;
  const net   = s.net_pay || entry.net_pay || 0;
  const totalDed = s.total_deductions || deductions.reduce((a, [, v]) => a + v, 0);

  const rows = (arr) => arr.map(([l, v]) => `
    <tr>
      <td style="padding:6px 10px;color:#374151;">${l}</td>
      <td style="padding:6px 10px;text-align:right;color:#111827;font-weight:600;">
        ${fmtINR(v)}
      </td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Payslip — ${name} — ${period}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Segoe UI', sans-serif; font-size:13px; color:#111827; padding:32px; }
    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; padding-bottom:16px; border-bottom:2px solid #6B3FDB; }
    .company { font-size:20px; font-weight:800; color:#6B3FDB; }
    .period  { font-size:14px; font-weight:600; color:#374151; }
    .emp-row { display:flex; gap:40px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:14px 18px; margin-bottom:20px; }
    .emp-item { display:flex; flex-direction:column; gap:2px; }
    .emp-item span { font-size:10px; color:#9ca3af; text-transform:uppercase; letter-spacing:.04em; }
    .emp-item strong { font-size:13px; color:#111827; }
    .sections { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:20px; }
    .section h4 { font-size:11px; font-weight:700; color:#6b7280; text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px; }
    table { width:100%; border-collapse:collapse; }
    th { background:#f3f4f6; padding:6px 10px; text-align:left; font-size:11px; color:#6b7280; }
    tr:nth-child(even) td { background:#fafafa; }
    .total-row td { border-top:2px solid #e5e7eb; padding:8px 10px; font-weight:700; }
    .net-box { background:linear-gradient(135deg,#6B3FDB,#8b5cf6); color:#fff; border-radius:10px; padding:18px 24px; display:flex; justify-content:space-between; align-items:center; }
    .net-box .lbl { font-size:12px; opacity:.85; }
    .net-box .val { font-size:22px; font-weight:800; }
    .footer { margin-top:20px; text-align:center; font-size:11px; color:#9ca3af; }
    @media print { body { padding:16px; } .net-box { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="company">Pulse ERP</div>
    <div class="period">Payslip — ${period}</div>
  </div>

  <div class="emp-row">
    <div class="emp-item"><span>Employee Name</span><strong>${name}</strong></div>
    <div class="emp-item"><span>Department</span><strong>${dept || '—'}</strong></div>
    <div class="emp-item"><span>Designation</span><strong>${desig || '—'}</strong></div>
    <div class="emp-item"><span>Pay Period</span><strong>${period}</strong></div>
  </div>

  <div class="sections">
    <div class="section">
      <h4>Earnings</h4>
      <table>
        <thead><tr><th>Component</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>
          ${rows(earnings)}
          <tr class="total-row">
            <td>Gross Earnings</td>
            <td style="text-align:right">${fmtINR(gross)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="section">
      <h4>Deductions</h4>
      <table>
        <thead><tr><th>Component</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>
          ${rows(deductions)}
          <tr class="total-row">
            <td>Total Deductions</td>
            <td style="text-align:right">${fmtINR(totalDed)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="net-box">
    <div><div class="lbl">Net Pay (Take-Home)</div></div>
    <div class="val">${fmtINR(net)}</div>
  </div>

  <div class="footer">This is a system-generated payslip. No signature required. — Pulse ERP</div>

  <script>window.onload = () => { window.print(); };</script>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=800,height=700');
  if (w) {
    w.document.write(html);
    w.document.close();
  }
}

export default function MyPayslipsWidget() {
  const { user } = useAuth();
  const [payslips, setPayslips]     = useState([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [downloading, setDownloading] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {

        const res = await api.get('/payroll/my-payslips');
        if (!cancelled) {
          const list = res.data?.data || res.data || [];
          setPayslips(Array.isArray(list) ? list : []);
        }
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.message || e.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [user?.employee_id]);

  async function handleDownload(entry) {
    const key = `${entry.month}-${entry.year}`;
    setDownloading(key);
    try {
      if (!entry.slip) {
        const res = await api.get('/payroll/payslips', {
          params: { employee_id: entry.employee_id, month: entry.month, year: entry.year },
        });
        entry = { ...entry, slip: res.data?.data || res.data };
      }
    } catch {
      // use whatever slip data we have
    } finally {
      setDownloading(null);
    }
    printPayslip(entry);
  }

  if (loading) {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'20px 16px', color:'#9ca3af', fontSize:13 }}>
        <Loader size={14} style={{ animation:'spin .7s linear infinite' }} />
        Loading payslips…
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'16px', color:'#dc2626', fontSize:13 }}>
        <AlertCircle size={14} />
        {error}
      </div>
    );
  }

  if (payslips.length === 0) {
    return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:'32px 16px', color:'#9ca3af' }}>
        <FileText size={28} strokeWidth={1.5} />
        <span style={{ fontSize:13 }}>No payslip data found</span>
      </div>
    );
  }

  const recentPayslips = payslips.slice(0, 3);

  return (
    <div style={{ display:'flex', flexDirection:'column' }}>
      {recentPayslips.map((p, i) => {
        const key = `${p.month}-${p.year}`;
        const isLast = i === recentPayslips.length - 1;
        return (
          <div
            key={key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 14px',
              borderBottom: isLast ? 'none' : '1px solid #f3f4f6',
            }}
          >
            <div style={{
              width: 30, height: 30, borderRadius: 7,
              background: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <FileText size={14} color="#6B3FDB" />
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>
                {p.period_label}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>
                Net {fmtINR(p.net_pay)}
                {p.gross_pay > 0 && (
                  <span style={{ marginLeft: 6, color: '#9ca3af' }}>· Gross {fmtINR(p.gross_pay)}</span>
                )}
              </div>
            </div>

            <button
              onClick={() => handleDownload(p)}
              disabled={downloading === key}
              title={`Download ${p.period_label} payslip`}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                background: downloading === key ? '#f3f4f6' : '#E8E1FC',
                border: 'none', borderRadius: 6,
                padding: '5px 10px',
                fontSize: 11, fontWeight: 600,
                color: downloading === key ? '#9ca3af' : '#4B2DCE',
                cursor: downloading === key ? 'default' : 'pointer',
                transition: 'background .15s',
                flexShrink: 0,
              }}
            >
              {downloading === key
                ? <Loader size={11} style={{ animation:'spin .7s linear infinite' }} />
                : <Download size={11} />
              }
              {downloading === key ? 'Wait…' : 'Download'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
