import { useState, useEffect, useRef, useCallback } from 'react';
import { FileText, Download, Users, AlertCircle, CheckCircle, X, Search } from 'lucide-react';
import api from '@/services/api/client';

const currentFY = () => {
  const now = new Date();
  const yr  = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${yr}-${yr + 1}`;
};

const FY_OPTIONS = (() => {
  const base = new Date().getFullYear();
  return [0, 1, 2].map(i => {
    const yr = base - i;
    return `${yr}-${yr + 1}`;
  });
})();

export default function PayrollForm16({ setPage: _setPage }) {
  const [employees,   setEmployees]   = useState([]);
  const [fy,          setFy]          = useState(currentFY());
  const [loading,     setLoading]     = useState(false);
  const [dlLoading,   setDlLoading]   = useState({});
  const [bulkLoading, setBulkLoading] = useState(false);
  const [toast,       setToast]       = useState(null);
  const [search,      setSearch]      = useState('');
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 4000);
  };

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/payroll', { params: { limit: 500 } });
      if (!isMounted.current) return;
      const list = r?.data?.payroll || r?.data?.data || r?.data || [];
      setEmployees(Array.isArray(list) ? list : []);
    } catch {
      if (isMounted.current) showToast('Could not load employee list', 'error');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const downloadForm16 = async (employeeId, empName) => {
    setDlLoading(p => ({ ...p, [employeeId]: true }));
    try {
      const r = await api.get(`/payroll/form16/${employeeId}`, {
        params: { financial_year: fy },
        responseType: 'blob',
      });
      const url  = URL.createObjectURL(new Blob([r.data]));
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `Form16_${empName.replace(/\s+/g, '_')}_${fy}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Form 16 downloaded for ${empName}`);
    } catch (e) {
      const msg = e?.response?.status === 404
        ? `No payroll data found for ${empName} in FY ${fy}`
        : `Download failed for ${empName}`;
      showToast(msg, 'error');
    } finally {
      if (isMounted.current) setDlLoading(p => ({ ...p, [employeeId]: false }));
    }
  };

  const downloadAll = async () => {
    if (!filtered.length) return;
    setBulkLoading(true);
    let success = 0, failed = 0;
    for (const emp of filtered) {
      try {
        const r = await api.get(`/payroll/form16/${emp.employee_id}`, {
          params: { financial_year: fy },
          responseType: 'blob',
        });
        const name = emp.name || emp.employee_name || `EMP_${emp.employee_id}`;
        const url  = URL.createObjectURL(new Blob([r.data]));
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
      showToast(`Downloaded ${success} Form 16s${failed ? ` (${failed} failed — no payroll data)` : ''}`, failed ? 'error' : 'success');
    }
  };

  const filtered = employees.filter(e => {
    if (!search) return true;
    const name = (e.name || e.employee_name || '').toLowerCase();
    const dept = (e.department || '').toLowerCase();
    const code = String(e.employee_id || e.office_id || '').toLowerCase();
    return name.includes(search.toLowerCase()) || dept.includes(search.toLowerCase()) || code.includes(search.toLowerCase());
  });

  const card   = { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,.08)' };
  const btn    = (bg, color = '#fff') => ({ background: bg, color, border: 'none', borderRadius: 8,
    padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 });

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#6B3FDB,#5b21b6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileText size={22} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Form 16</h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Annual TDS certificates for employees</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={fy} onChange={e => setFy(e.target.value)}
            style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, background: '#fff' }}>
            {FY_OPTIONS.map(f => <option key={f} value={f}>FY {f}</option>)}
          </select>
          <button style={btn('#6B3FDB')} onClick={downloadAll} disabled={bulkLoading || !filtered.length}>
            <Download size={15} />
            {bulkLoading ? 'Downloading...' : `Download All (${filtered.length})`}
          </button>
        </div>
      </div>

      {/* Info card */}
      <div style={{ ...card, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12,
        borderLeft: '4px solid #6B3FDB', padding: '14px 20px' }}>
        <FileText size={18} color="#6B3FDB" />
        <div style={{ fontSize: 13, color: '#374151' }}>
          Form 16 is generated from saved payroll runs for FY <strong>{fy}</strong> (April–March).
          Employees with no payroll data for the selected FY will show a download error.
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
        ) : !filtered.length ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 14 }}>
            {search ? 'No employees match your search.' : 'No employee data available.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f3f4f6' }}>
                  {['Employee', 'Department', 'Designation', 'FY', 'Action'].map(h => (
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
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{emp.office_id || `ID: ${id}`}</div>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{emp.department || '—'}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{emp.designation || '—'}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{fy}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <button style={btn(isLoading ? '#e5e7eb' : '#6B3FDB', isLoading ? '#9ca3af' : '#fff')}
                          disabled={isLoading}
                          onClick={() => downloadForm16(id, name)}>
                          <Download size={13} />
                          {isLoading ? 'Downloading...' : 'Download'}
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
    </div>
  );
}
