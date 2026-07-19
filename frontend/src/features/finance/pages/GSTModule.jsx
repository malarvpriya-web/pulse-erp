import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Download, RefreshCw, AlertCircle, CheckCircle,
  FileSpreadsheet, Printer, X,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useFY } from '@/context/FYContext';
import FYSelector from '@/components/core/FYSelector';

const fmt = n => `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const PERIODS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(); d.setMonth(d.getMonth() - i);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return { value: `${m}${d.getFullYear()}`, label: d.toLocaleString('en-IN', { month: 'long', year: 'numeric' }) };
});

function periodLabel(p) {
  const known = PERIODS.find(x => x.value === p)?.label;
  if (known) return known;
  // Fallback: parse an MMYYYY period value into "Month YYYY"
  if (/^\d{6}$/.test(p || '')) {
    const mm = parseInt(p.slice(0, 2), 10);
    const yyyy = parseInt(p.slice(2), 10);
    return new Date(yyyy, mm - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  }
  return p;
}

function Tab({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
      background: active ? '#6366f1' : 'transparent',
      color: active ? '#fff' : '#6b7280', fontSize: 13, fontWeight: 500,
      transition: 'all .15s',
    }}>{label}</button>
  );
}

function KPI({ label, value, sub, color = '#6366f1' }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '16px 20px', flex: 1, minWidth: 160 }}>
      <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function FilingBadge({ status }) {
  const cfg = {
    draft:     { label: 'Draft',      bg: '#f3f4f6', color: '#6b7280' },
    submitted: { label: 'Submitted',  bg: '#fef3c7', color: '#92400e' },
    filed:     { label: 'Filed ✓',   bg: '#dcfce7', color: '#166534' },
    nil_filed: { label: 'Nil Return', bg: '#e0f2fe', color: '#0369a1' },
  };
  const s = cfg[status] || cfg.draft;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

function MarkFiledModal({ period, returnType, onClose, onFiled }) {
  const toast = useToast();
  const [refNo,   setRefNo]   = useState('');
  const [filedAt, setFiledAt] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    try {
      await api.post('/gst/filing-status', {
        period, return_type: returnType, status: 'filed',
        reference_no: refNo, filed_at: filedAt,
      });
      onFiled();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to mark as filed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>Mark {returnType.toUpperCase()} as Filed</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#6b7280' }}><X size={18}/></button>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>ARN / Acknowledgement Number</label>
          <input value={refNo} onChange={e => setRefNo(e.target.value)} placeholder="e.g. AA123456789012P"
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}/>
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Filing Date</label>
          <input type="date" value={filedAt} onChange={e => setFiledAt(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}/>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 9, background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={submit} disabled={loading}
            style={{ flex: 1, padding: 9, background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, opacity: loading ? .7 : 1 }}>
            {loading ? 'Saving…' : 'Confirm Filed'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── GSTR-1 Tab ────────────────────────────────────────────────────────────────
function GSTR1Tab({ period, setPeriod, companyGstin, periods = PERIODS }) {
  const [data,          setData]          = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState(null);
  const [filingStatus,  setFilingStatus]  = useState('draft');
  const [showFiledModal, setShowFiledModal] = useState(false);

  const loadFiling = useCallback(async (p) => {
    try {
      const res = await api.get(`/gst/filing-status?period=${p}&type=gstr1`);
      setFilingStatus(res.data?.status || 'draft');
    } catch {
      setFilingStatus('draft');
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/gst/gstr1?period=${period}`);
      setData(res.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load GSTR-1 data');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
    loadFiling(period);
  }, [load, loadFiling, period]);

  const filed = filingStatus === 'filed' || filingStatus === 'nil_filed';
  const s = data?.summary ?? {};
  const b2bRows = data?.b2b ?? [];
  const noData  = !loading && !error && b2bRows.length === 0 && !(s.b2b_invoices);

  const exportJSON = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `GSTR1_${period}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportCSV = async () => {
    try {
      const res = await api.get(`/gst/gstr1/export?period=${period}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `GSTR1_${period}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      // fallback: build CSV from fetched data
      if (!data) return;
      const rows = data.b2b ?? [];
      const lines = [
        'Invoice No.,Party,GSTIN,Taxable Value,IGST,CGST,SGST,Total',
        ...rows.map(r => [r.invoice_number, r.party_name || '', r.party_gstin || '', r.taxable_value ?? 0, r.igst ?? 0, r.cgst ?? 0, r.sgst ?? 0, r.total_amount ?? 0].join(',')),
      ].join('\n');
      const url = URL.createObjectURL(new Blob([lines], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `GSTR1_${period}.csv`; a.click();
      URL.revokeObjectURL(url);
    }
  };

  const exportPDF = () => {
    const lbl = periodLabel(period);
    const html = `<!DOCTYPE html><html><head><title>GSTR-1 — ${lbl}</title>
<style>body{font-family:Arial,sans-serif;margin:28px;color:#111}h2{margin-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:12px}
th,td{border:1px solid #ddd;padding:7px 10px}th{background:#f3f4f6;font-size:11px}
.kpis{display:flex;gap:20px;margin:12px 0;font-size:13px}.kpi{background:#f9fafb;padding:8px 14px;border-radius:6px}
.kpi b{display:block;font-size:16px;margin-top:2px}footer{margin-top:24px;font-size:11px;color:#888}
</style></head><body>
<h2>GSTR-1 — ${lbl}</h2>
${companyGstin ? `<p style="margin:2px 0;font-size:13px;color:#555">GSTIN: <strong style="font-family:monospace">${companyGstin}</strong></p>` : ''}
<div class="kpis">
  <div class="kpi"><span>B2B Invoices</span><b>${s.b2b_invoices ?? 0}</b></div>
  <div class="kpi"><span>B2C Invoices</span><b>${s.b2c_invoices ?? 0}</b></div>
  <div class="kpi"><span>Taxable Value</span><b>${fmt(s.total_taxable_value)}</b></div>
  <div class="kpi"><span>Total IGST</span><b>${fmt(s.total_igst)}</b></div>
  <div class="kpi"><span>CGST+SGST</span><b>${fmt((s.total_cgst ?? 0) + (s.total_sgst ?? 0))}</b></div>
</div>
<h3 style="margin-bottom:4px">B2B Transactions</h3>
<table><thead><tr><th>Invoice No.</th><th>Party</th><th>GSTIN</th><th>Taxable</th><th>IGST</th><th>CGST</th><th>SGST</th><th>Total</th></tr></thead>
<tbody>${b2bRows.length ? b2bRows.map(r => `<tr><td>${r.invoice_number}</td><td>${r.party_name || ''}</td><td style="font-family:monospace">${r.party_gstin || '—'}</td><td style="text-align:right">${fmt(r.taxable_value)}</td><td style="text-align:right">${fmt(r.igst)}</td><td style="text-align:right">${fmt(r.cgst)}</td><td style="text-align:right">${fmt(r.sgst)}</td><td style="text-align:right"><b>${fmt(r.total_amount)}</b></td></tr>`).join('') : '<tr><td colspan="8" style="text-align:center;color:#888">No B2B transactions for this period</td></tr>'}
</tbody></table>
<footer>Generated: ${new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })} — Verify against your accounting records before filing on the GST portal.</footer>
</body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    w.print();
  };

  const fileNilReturn = async () => {
    try {
      await api.post('/gst/filing-status', {
        period, return_type: 'gstr1', status: 'nil_filed',
        reference_no: null, filed_at: new Date().toISOString().slice(0, 10),
      });
      setFilingStatus('nil_filed');
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to file nil return');
    }
  };

  const btnBase = { padding: '7px 14px', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 };

  return (
    <div>
      {showFiledModal && (
        <MarkFiledModal period={period} returnType="gstr1"
          onClose={() => setShowFiledModal(false)}
          onFiled={() => { setFilingStatus('filed'); loadFiling(period); }}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={period} onChange={e => setPeriod(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' }}>
          {periods.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <FilingBadge status={filingStatus}/>

        <button onClick={load} disabled={filed || loading}
          style={{ ...btnBase, background: filed ? '#f3f4f6' : '#6366f1', color: filed ? '#9ca3af' : '#fff', cursor: (filed || loading) ? 'not-allowed' : 'pointer', opacity: loading ? .7 : 1 }}>
          <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : {}}/> Fetch
        </button>

        <button onClick={exportJSON} disabled={!data || filed}
          style={{ ...btnBase, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', opacity: (!data || filed) ? .5 : 1, cursor: (data && !filed) ? 'pointer' : 'not-allowed' }}>
          <Download size={13}/> JSON
        </button>
        <button onClick={exportCSV} disabled={!data || filed}
          style={{ ...btnBase, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', opacity: (!data || filed) ? .5 : 1, cursor: (data && !filed) ? 'pointer' : 'not-allowed' }}>
          <FileSpreadsheet size={13}/> CSV
        </button>
        <button onClick={exportPDF} disabled={!data}
          style={{ ...btnBase, background: '#fdf4ff', color: '#7e22ce', border: '1px solid #e9d5ff', opacity: !data ? .5 : 1, cursor: data ? 'pointer' : 'not-allowed' }}>
          <Printer size={13}/> PDF
        </button>

        {!filed && data && (
          <button onClick={() => setShowFiledModal(true)}
            style={{ ...btnBase, background: '#10b981', color: '#fff', marginLeft: 'auto' }}>
            Mark as Filed
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <AlertCircle size={14}/> {error}
        </div>
      )}

      {!error && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          <KPI label="B2B Invoices"  value={s.b2b_invoices ?? 0} color="#6366f1"/>
          <KPI label="B2C Invoices"  value={s.b2c_invoices ?? 0} color="#3b82f6"/>
          <KPI label="Taxable Value" value={fmt(s.total_taxable_value)} color="#10b981"/>
          <KPI label="Total IGST"    value={fmt(s.total_igst)} color="#f59e0b"/>
          <KPI label="CGST + SGST"   value={fmt((s.total_cgst ?? 0) + (s.total_sgst ?? 0))} color="#8b5cf6"/>
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #f5f5f7', fontSize: 13, fontWeight: 600, color: '#374151' }}>
          B2B Transactions — {periodLabel(period)}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['Invoice No.', 'Party', 'GSTIN', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: ['Invoice No.', 'Party', 'GSTIN'].includes(h) ? 'left' : 'right', fontWeight: 600, color: '#6b7280', fontSize: 11 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>Loading…</td></tr>
            ) : noData ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 36 }}>
                <div style={{ color: '#9ca3af', fontSize: 13, marginBottom: 12 }}>
                  No transactions found for {periodLabel(period)}.
                </div>
                {!filed && (
                  <button onClick={fileNilReturn}
                    style={{ padding: '7px 16px', background: '#e0f2fe', color: '#0369a1', border: '1px solid #bae6fd', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
                    File Nil Return
                  </button>
                )}
              </td></tr>
            ) : (
              b2bRows.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid #f5f5f7' }}>
                  <td style={{ padding: '10px 14px', color: '#6366f1', fontWeight: 500 }}>{r.invoice_number}</td>
                  <td style={{ padding: '10px 14px' }}>{r.party_name}</td>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 11 }}>{r.party_gstin || '—'}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>{fmt(r.taxable_value)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>{fmt(r.igst)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>{fmt(r.cgst)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>{fmt(r.sgst)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600 }}>{fmt(r.total_amount)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── GSTR-3B Tab ───────────────────────────────────────────────────────────────
function GSTR3BTab({ period, setPeriod, periods = PERIODS }) {
  const [data,          setData]          = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState(null);
  const [filingStatus,  setFilingStatus]  = useState('draft');
  const [showFiledModal, setShowFiledModal] = useState(false);

  const loadFiling = useCallback(async () => {
    try {
      const res = await api.get(`/gst/filing-status?period=${period}&type=gstr3b`);
      setFilingStatus(res.data?.status || 'draft');
    } catch {
      setFilingStatus('draft');
    }
  }, [period]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/gst/gstr3b?period=${period}`);
      setData(res.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to compute GSTR-3B');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
    loadFiling();
  }, [load, loadFiling]);

  const filed = filingStatus === 'filed' || filingStatus === 'nil_filed';

  const row = (label, igst, cgst, sgst, bold = false) => (
    <tr style={{ borderTop: '1px solid #f5f5f7' }}>
      <td style={{ padding: '10px 14px', fontWeight: bold ? 600 : 400, color: bold ? '#111827' : '#374151' }}>{label}</td>
      {[igst, cgst, sgst, (parseFloat(igst) || 0) + (parseFloat(cgst) || 0) + (parseFloat(sgst) || 0)].map((v, i) => (
        <td key={i} style={{ padding: '10px 14px', textAlign: 'right', fontWeight: bold ? 700 : 400, color: bold ? '#111827' : '#6b7280' }}>{fmt(v)}</td>
      ))}
    </tr>
  );

  return (
    <div>
      {showFiledModal && (
        <MarkFiledModal period={period} returnType="gstr3b"
          onClose={() => setShowFiledModal(false)}
          onFiled={() => { setFilingStatus('filed'); loadFiling(); }}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={period} onChange={e => setPeriod(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' }}>
          {periods.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <FilingBadge status={filingStatus}/>
        <button onClick={load} disabled={filed || loading}
          style={{ padding: '7px 14px', background: (filed || loading) ? '#f3f4f6' : '#6366f1', color: (filed || loading) ? '#9ca3af' : '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: (filed || loading) ? 'not-allowed' : 'pointer' }}>
          Compute
        </button>
        {!filed && data && (
          <button onClick={() => setShowFiledModal(true)}
            style={{ padding: '7px 14px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', marginLeft: 'auto' }}>
            Mark as Filed
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <AlertCircle size={14}/> {error}
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Computing…</div>}

      {!loading && !error && data && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <KPI label="Output Tax"      value={fmt(data.outward_supplies?.total_tax)} color="#ef4444"/>
            <KPI label="Input Tax Credit" value={fmt(data.itc_available?.total_itc)} color="#10b981"/>
            <KPI label="Net Payable"     value={fmt(data.net_tax_payable)} color="#6366f1" sub="After ITC set-off"/>
          </div>

          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #f5f5f7', fontSize: 13, fontWeight: 600 }}>GSTR-3B Summary</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Description', 'IGST', 'CGST', 'SGST', 'Total'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Description' ? 'left' : 'right', fontWeight: 600, color: '#6b7280', fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {row('3.1 Outward taxable supplies', data.outward_supplies?.igst, data.outward_supplies?.cgst, data.outward_supplies?.sgst, true)}
                {row('4. ITC Available', data.itc_available?.igst, data.itc_available?.cgst, data.itc_available?.sgst)}
                {row('Net Tax Payable', data.igst_payable, data.cgst_payable, data.sgst_payable, true)}
              </tbody>
            </table>
          </div>

          <div style={{ background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 10, padding: '12px 16px', fontSize: 12, color: '#92400e', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }}/>
            <span>Computed summary — verify against your accounting records before filing. Due date: 20th of the following month.</span>
          </div>
        </>
      )}

      {!loading && !error && !data && (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af', fontSize: 13 }}>
          Select a period and click Compute to generate GSTR-3B summary.
        </div>
      )}
    </div>
  );
}

// ── TDS Calculator Tab ────────────────────────────────────────────────────────
function TDSTab() {
  const [sections,  setSections]  = useState({});
  const [section,   setSection]   = useState('194J');
  const [amount,    setAmount]    = useState('');
  const [pan,       setPan]       = useState(true);
  const [result,    setResult]    = useState(null);
  const [loadingSec, setLoadingSec] = useState(true);

  useEffect(() => {
    api.get('/gst/tds/sections')
      .then(res => { setSections(res.data); setLoadingSec(false); })
      .catch(() => {
        setSections({
          '194A': { description: 'Interest (non-bank)',           rate_with_pan: 10, rate_without_pan: 20, threshold: 40000  },
          '194C': { description: 'Contractor / sub-contractor',   rate_with_pan: 1,  rate_without_pan: 20, threshold: 30000  },
          '194H': { description: 'Commission / brokerage',        rate_with_pan: 5,  rate_without_pan: 20, threshold: 15000  },
          '194I': { description: 'Rent (land / building)',        rate_with_pan: 10, rate_without_pan: 20, threshold: 240000 },
          '194J': { description: 'Professional / technical fees', rate_with_pan: 10, rate_without_pan: 20, threshold: 30000  },
        });
        setLoadingSec(false);
      });
  }, []);

  const compute = async () => {
    try {
      const res = await api.post('/gst/tds/compute', {
        section, amount: parseFloat(amount) || 0, pan_available: pan, deductee_type: 'company',
      });
      setResult(res.data);
    } catch {
      const s = sections[section];
      if (!s) return;
      const amt  = parseFloat(amount) || 0;
      const rate = pan ? s.rate_with_pan : Math.max(20, s.rate_without_pan ?? 20);
      const tds  = Math.round(amt * rate / 100);
      const ec   = Math.round(tds * 0.04);
      setResult({
        section, description: s.description, payment_amount: amt, tds_rate: rate,
        tds_amount: tds, surcharge: 0, education_cess: ec, total_tds: tds + ec,
        net_payment: amt - tds - ec, threshold: s.threshold, tds_applicable: amt >= s.threshold,
      });
    }
  };

  if (loadingSec) return <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading TDS sections…</div>;

  const sData = sections[section] || {};
  const rate  = pan ? (sData.rate_with_pan ?? 10) : Math.max(20, sData.rate_without_pan ?? 20);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 20 }}>
      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16, color: '#374151' }}>TDS Calculator</div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Section</label>
          <select value={section} onChange={e => { setSection(e.target.value); setResult(null); }}
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' }}>
            {Object.entries(sections).map(([k, v]) => (
              <option key={k} value={k}>{k} — {v.description}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Payment Amount (₹)</label>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="Enter amount"
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}/>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={pan} onChange={e => setPan(e.target.checked)}/>
            PAN available (rate doubles without PAN per Section 206AA)
          </label>
        </div>

        <button onClick={compute}
          style={{ width: '100%', padding: 9, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          Compute TDS
        </button>
        <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }}>
          Threshold: ₹{(sData.threshold ?? 0).toLocaleString('en-IN')} · Rate: {rate}%
          {!pan ? ' (no PAN — minimum 20%)' : ''}
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16, color: '#374151' }}>Computation Result</div>
        {!result ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 13 }}>Enter amount and click Compute TDS</div>
        ) : (
          <>
            {result.tds_applicable === false && (
              <div style={{ background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e', marginBottom: 16 }}>
                TDS not applicable — payment ₹{Number(result.payment_amount).toLocaleString('en-IN')} is below threshold ₹{Number(result.threshold).toLocaleString('en-IN')}
              </div>
            )}
            {[
              ['Section',               result.section],
              ['Description',           result.description],
              ['Payment Amount',        fmt(result.payment_amount)],
              ['TDS Rate',              `${result.tds_rate}%`],
              ['TDS Amount',            fmt(result.tds_amount)],
              ['Surcharge',             fmt(result.surcharge)],
              ['Education Cess (4%)',   fmt(result.education_cess)],
              ['Total TDS',             fmt(result.total_tds)],
              ['Net Payment to Party',  fmt(result.net_payment)],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f5f5f7', fontSize: 13 }}>
                <span style={{ color: '#6b7280' }}>{label}</span>
                <span style={{
                  fontWeight: (label.includes('Total') || label.includes('Net')) ? 700 : 400,
                  color: label.includes('Total TDS') ? '#ef4444' : label.includes('Net') ? '#15803d' : '#111827',
                }}>{value}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function GSTModule() {
  const { getMonthsInFY, fyLabel } = useFY();
  const [tab,    setTab]    = useState('gstr1');
  const [period, setPeriod] = useState(PERIODS[1]?.value);
  const [co,     setCo]     = useState(null);

  // Month options (Apr → Mar) scoped to the selected Financial Year
  const periods = useMemo(
    () => getMonthsInFY().map(m => {
      const [y, mm] = m.startStr.split('-');
      return { value: `${mm}${y}`, label: m.month };
    }),
    [getMonthsInFY],
  );

  // Keep the selected period valid whenever the FY (and hence period list) changes
  useEffect(() => {
    if (!periods.length) return;
    if (periods.some(p => p.value === period)) return;
    const keyOf = v => parseInt(v.slice(2), 10) * 100 + parseInt(v.slice(0, 2), 10);
    const now = new Date();
    const todayKey = now.getFullYear() * 100 + (now.getMonth() + 1);
    const elapsed = periods.filter(p => keyOf(p.value) <= todayKey);
    setPeriod((elapsed.length ? elapsed[elapsed.length - 1] : periods[0]).value);
  }, [periods]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/company-profile').then(res => setCo(res.data)).catch(() => {});
  }, []);

  const gstin = co?.gstin;
  const coName = co?.name;

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>GST & Tax Management</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>GSTR-1, GSTR-3B, TDS computation &amp; compliance · {fyLabel}</p>
        </div>
        <FYSelector />
      </div>

      {gstin ? (
        <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, padding: '10px 16px', fontSize: 13, color: '#0369a1', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <CheckCircle size={14}/>
          <span>Filing for: <strong>{coName}</strong> &nbsp;|&nbsp; GSTIN: <strong style={{ fontFamily: 'monospace' }}>{gstin}</strong></span>
        </div>
      ) : (
        <div style={{ background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 16px', fontSize: 13, color: '#92400e', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <AlertCircle size={14}/>
          <span>GSTIN not configured — go to <strong>Settings → Company Profile</strong> to set it up before filing.</span>
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, padding: 4, display: 'inline-flex', gap: 2, marginBottom: 20 }}>
        <Tab label="GSTR-1 (Outward)" active={tab === 'gstr1'}  onClick={() => setTab('gstr1')}/>
        <Tab label="GSTR-3B (Return)" active={tab === 'gstr3b'} onClick={() => setTab('gstr3b')}/>
        <Tab label="TDS Calculator"   active={tab === 'tds'}    onClick={() => setTab('tds')}/>
      </div>

      {tab === 'gstr1'  && <GSTR1Tab  period={period} setPeriod={setPeriod} companyGstin={gstin} periods={periods}/>}
      {tab === 'gstr3b' && <GSTR3BTab period={period} setPeriod={setPeriod} periods={periods}/>}
      {tab === 'tds'    && <TDSTab/>}
    </div>
  );
}
