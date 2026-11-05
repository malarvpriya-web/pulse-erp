import { useState, useEffect, useRef, useCallback } from 'react';
import {
  FileText, Download, Users, AlertCircle, CheckCircle, X, Search,
  Wallet,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { certificateName, periodTerm } from '../components/payroll/taxFormNames';

const currentFY = () => {
  const now = new Date();
  const yr  = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${yr}-${yr + 1}`;
};

const FY_OPTIONS = (() => {
  const base = parseInt(currentFY(), 10);
  return [0, 1, 2].map(i => {
    const yr = base - i;
    return `${yr}-${yr + 1}`;
  });
})();

export default function PayrollForm16({ setPage: _setPage, embedded = false }) {
  const [employees,   setEmployees]   = useState([]);
  const [fy,          setFy]          = useState(currentFY());
  const [loading,     setLoading]     = useState(false);
  const [dlLoading,   setDlLoading]   = useState({});
  const [bulkLoading, setBulkLoading] = useState(false);
  const [toast,       setToast]       = useState(null);
  const [search,      setSearch]      = useState('');
  const [lifecycle,   setLifecycle]   = useState(null);
  const [loadError,   setLoadError]   = useState(null);
  const name = certificateName(fy);
  const term = periodTerm(fy);
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 4000);
  };

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await api.get('/payroll/form16-status', { params: { financial_year: fy } });
      if (!isMounted.current) return;
      const data = r?.data?.data || null;
      setLifecycle(data);
      setEmployees(Array.isArray(data?.employees) ? data.employees : []);
    } catch (e) {
      if (!isMounted.current) return;
      setLifecycle(null);
      setEmployees([]);
      setLoadError(e?.response?.data?.message || e?.response?.data?.error || e?.message || 'request failed');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [fy]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const downloadForm16 = async (employeeId, empName) => {
    setDlLoading(p => ({ ...p, [employeeId]: true }));
    try {
      const r = await api.get(`/payroll/form16/${employeeId}/pdf`, {
        params: { financial_year: fy },
        responseType: 'blob',
      });
      const url  = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `Form16_${empName.replace(/\s+/g, '_')}_${fy}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`${name} Part B downloaded for ${empName}`);
    } catch (e) {
      const msg = e?.response?.status === 409
        ? `${name} for ${empName} is not ready: ${(e?.response?.data?.blockers || []).join('; ') || 'see the Status column'}`
        : e?.response?.status === 404 ? `No finalised payroll for ${empName} in ${term} ${fy}` : `Download failed for ${empName}`;
      showToast(msg, 'error');
    } finally {
      if (isMounted.current) setDlLoading(p => ({ ...p, [employeeId]: false }));
    }
  };

  const downloadAll = async () => {
    if (!filtered.length) return;
    setBulkLoading(true);
    let success = 0, failed = 0;
    for (const emp of filtered.filter(e => e.can_generate)) {
      try {
        const r = await api.get(`/payroll/form16/${emp.employee_id}/pdf`, {
          params: { financial_year: fy },
          responseType: 'blob',
        });
        const name = emp.name || emp.employee_name || `EMP_${emp.employee_id}`;
        const url  = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `Form16_${name.replace(/\s+/g, '_')}_${fy}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
        success++;
        await new Promise(r => setTimeout(r, 300)); // avoid browser blocking multiple downloads
      } catch { failed++; }
    }
    if (isMounted.current) {
      setBulkLoading(false);
      showToast(`Downloaded ${success} ${name} Part B file(s)${failed ? ` (${failed} failed)` : ''}`, failed ? 'error' : 'success');
    }
  };

  const filtered = employees.filter(e => {
    if (!search) return true;
    const name = (e.name || e.employee_name || '').toLowerCase();
    const dept = (e.department || '').toLowerCase();
    const code = String(e.employee_code || '').toLowerCase();
    return name.includes(search.toLowerCase()) || dept.includes(search.toLowerCase()) || code.includes(search.toLowerCase());
  });

  const card   = { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,.08)' };
  const btn    = (bg, color = '#fff') => ({ background: bg, color, border: 'none', borderRadius: 8,
    padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 });

  return (
    <PageShell embedded={embedded} dock={embedded ? null :
      <PageHero
        icon={Wallet}
        eyebrow="Human Resources"
        title={name}
        subtitle="Annual salary TDS certificate (Part B) for employees"
      />
    }>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 18px', borderRadius: 10,
          background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`,
          boxShadow: '0 4px 20px rgba(0,0,0,.1)',
          color: toast.type === 'error' ? '#991b1b' : '#166534', fontSize: 13, fontWeight: 500 }}>
          {toast.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle size={15} />}
          {toast.message}
          <button onClick={() => setToast(null)} style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            <X size={13} />
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={fy} onChange={e => setFy(e.target.value)}
            style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, background: '#fff' }}>
            {FY_OPTIONS.map(f => <option key={f} value={f}>{periodTerm(f)} {f}</option>)}
          </select>
          <button style={{ ...btn('#6B3FDB'), opacity: filtered.some(e => e.can_generate) ? 1 : 0.45 }} onClick={downloadAll}
            disabled={bulkLoading || !filtered.some(e => e.can_generate)}>
            <Download size={15} />
            {bulkLoading ? 'Downloading...' : `Download Ready (${filtered.filter(e => e.can_generate).length})`}
          </button>
        </div>
      </div>
      {!loading && !loadError && employees.length > 0 && !employees.some(e => e.can_generate) && (
        <p style={{ margin: '-6px 0 14px', fontSize: 12, color: '#92400e', textAlign: 'right' }}>
          <strong>No certificate is ready to download.</strong>{' '}
          {lifecycle && !lifecycle.fy_ended
            ? `${term} ${fy} has not ended; certificates are issued after ${lifecycle.fy_end}.`
            : 'Each employee\'s blockers are listed in the Status column.'}
        </p>
      )}

      {/* Info card */}
      <div style={{ ...card, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12,
        borderLeft: '4px solid #6B3FDB', padding: '14px 20px' }}>
        <FileText size={18} color="#6B3FDB" />
        <div style={{ fontSize: 13, color: '#374151' }}>
          {name} is the <strong>annual</strong> salary TDS certificate for {term} <strong>{fy}</strong> (April–March), built from
          approved payroll only. It can be issued only after the year ends{lifecycle ? <> — {lifecycle.fy_end} — and is due by <strong>{lifecycle.issue_due_by}</strong></> : null}.
          Part A comes from TRACES; this produces Part B.
          {lifecycle && !lifecycle.fy_ended && <><br /><strong style={{ color: '#b45309' }}>{term} {fy} is still in progress — no {name} can be final yet.</strong></>}
          {lifecycle && !lifecycle.tan_configured && <><br /><strong style={{ color: '#b91c1c' }}>Employer TAN is not configured (Company profile).</strong></>}
        </div>
      </div>

      {/* Search + Table */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: '#1f2937' }}>
            <Users size={16} color="#6B3FDB" />
            {loading ? 'Loading employees...' : `${filtered.length} employee${filtered.length !== 1 ? 's' : ''}`}
          </div>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, dept, code..."
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 12px 7px 30px', fontSize: 13, width: 240 }} />
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 14 }}>Loading employees...</div>
        ) : loadError ? (
          <div role="alert" style={{ textAlign: 'center', padding: 40, color: '#991b1b', fontSize: 14 }}>
            Could not load the {name} status for {term} {fy}: {loadError}. It is not known whether any certificate is ready.
            <div style={{ marginTop: 12 }}>
              <button style={btn('#6B3FDB')} onClick={loadEmployees}>Retry</button>
            </div>
          </div>
        ) : !filtered.length ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 14 }}>
            {search ? 'No employees match your search.' : `No approved or paid payroll in ${term} ${fy} yet — an employee appears here once at least one month is approved.`}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f3f4f6' }}>
                  {['Employee', 'Department', 'Months finalised', 'Status', 'Action'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((emp, i) => {
                  const id   = emp.employee_id || emp.id;
                  const name = emp.name || emp.employee_name || `Employee ${id}`;
                  const isLoading = dlLoading[id];
                  return (
                    <tr key={id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ fontWeight: 600, color: '#1f2937' }}>{name}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{emp.employee_code || '—'}</div>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{emp.department || '—'}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{emp.months_finalised} of {emp.months_expected}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                          background: emp.status === 'ready' ? '#d1fae5' : emp.status === 'in_progress' ? '#ede9fe' : '#fef3c7',
                          color: emp.status === 'ready' ? '#065f46' : emp.status === 'in_progress' ? '#5b21b6' : '#92400e' }}>
                          {{ ready: 'Ready', in_progress: 'Year in progress', awaiting_data: 'Awaiting data', no_salary: 'No finalised salary' }[emp.status] || emp.status}
                        </span>
                        {emp.blockers?.length > 0 && (
                          <div style={{ fontSize: 11, color: '#92400e', marginTop: 4 }}>{emp.blockers.join(' · ')}</div>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <button style={{ ...btn(isLoading || !emp.can_generate ? '#e5e7eb' : '#6B3FDB', isLoading || !emp.can_generate ? '#9ca3af' : '#fff') }}
                          disabled={isLoading || !emp.can_generate}
                          title={emp.can_generate ? `Download ${name} Part B` : (emp.blockers || []).join('\n')}
                          onClick={() => downloadForm16(id, name)}>
                          <Download size={13} />
                          {isLoading ? 'Downloading...' : emp.can_generate ? 'Download' : 'Not ready'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageShell>
  );
}
