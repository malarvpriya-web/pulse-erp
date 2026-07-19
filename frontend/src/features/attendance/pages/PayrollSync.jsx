import React, { useState, useEffect, useCallback } from 'react';
import {
  IndianRupee, Lock, Unlock, RefreshCw, Check, AlertTriangle,
  Download, Clock, Users, Zap, AlertCircle, ChevronDown, UserPlus,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };
const HR_ROLES = new Set(['admin', 'super_admin', 'hr', 'hr_admin', 'hr_manager']);

export default function PayrollSync({ setPage } = {}) {
  const { role } = useAuth();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear]   = useState(now.getFullYear());
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('success');
  const [selected, setSelected] = useState(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [showPayrollLink, setShowPayrollLink] = useState(false);

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/attendance/monthly-report?month=${month}&year=${year}`);
      const rows = res.data.records || [];
      setRecords(rows);
      setIsFrozen(rows.some(r => r.payroll_synced));
    } catch {
      setRecords([]);
    } finally { setLoading(false); }
  }, [month, year]);

  useEffect(() => { load(); }, [load]);

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === records.filter(r => !r.payroll_synced).length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(records.filter(r => !r.payroll_synced).map(r => r.employee_id)));
    }
  };

  const handleSync = async (force = false) => {
    setSyncing(true); setShowConfirm(false); setShowForceConfirm(false);
    try {
      const employeeIds = selected.size > 0 ? [...selected] : null;
      const res = await api.post('/attendance/payroll-sync', { month, year, employee_ids: employeeIds, force });
      const syncedCount = res.data.employees_processed ?? employeeIds?.length ?? records.length;
      setMsg(`Attendance ${force ? 're-synced' : 'frozen and synced'} for ${syncedCount} employees. Ready to run payroll.`);
      setMsgType('success');
      setIsFrozen(true);
      setShowPayrollLink(true);
      setRecords(prev => prev.map(r =>
        (!employeeIds || employeeIds.includes(r.employee_id)) ? { ...r, payroll_synced: true } : r
      ));
      setSelected(new Set());
    } catch (e) {
      if (e.response?.status === 409) {
        setMsg(`Already synced: ${e.response.data.message}`);
        setMsgType('error');
        setIsFrozen(true);
        load();
      } else {
        setMsg(e.response?.data?.error || 'Payroll sync failed');
        setMsgType('error');
      }
    } finally { setSyncing(false); setTimeout(() => setMsg(''), 6000); }
  };

  const exportCSV = () => {
    const headers = ['Employee','Department','Designation','Present Days','Absent Days','Late Days','Working Days','Total Hours','OT Hours','Mid-Month Joiner','Status'];
    const rows = records.map(r => [
      r.employee_name, r.department, r.designation,
      r.present_days, r.absent_days, r.late_days,
      r.is_mid_month_joiner ? r.prorated_working_days : r.working_days,
      parseFloat(r.total_hours || 0).toFixed(1),
      parseFloat(r.total_ot_hours || 0).toFixed(1),
      r.is_mid_month_joiner ? 'Yes' : 'No',
      r.payroll_synced ? 'Synced' : 'Pending',
    ]);
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `payroll_attendance_${MONTHS[month - 1]}_${year}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const pendingCount   = records.filter(r => !r.payroll_synced).length;
  const syncedCount    = records.filter(r => r.payroll_synced).length;
  const totalOT        = records.reduce((s, r) => s + parseFloat(r.total_ot_hours || 0), 0);
  const midMonthCount  = records.filter(r => r.is_mid_month_joiner).length;

  if (!HR_ROLES.has(role)) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <AlertCircle size={40} color="#f59e0b" style={{ marginBottom: 16 }} />
        <div style={{ fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 8 }}>Access Restricted</div>
        <div style={{ fontSize: 14, color: '#6b7280' }}>
          Payroll sync is available to HR Admin and Admin roles only.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Payroll Sync</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Freeze and sync monthly attendance to payroll — immutable once frozen</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {isFrozen && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '6px 12px', fontSize: 13, color: '#15803d', fontWeight: 600 }}>
              <Lock size={13} /> Frozen
            </div>
          )}
          <button onClick={exportCSV} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10, border: '1px solid #e9e4ff', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {msg && (
        <div style={{ background: msgType === 'success' ? '#f0fdf4' : '#fef2f2', border: `1px solid ${msgType === 'success' ? '#86efac' : '#fca5a5'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: msgType === 'success' ? '#15803d' : '#dc2626', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>
            {msgType === 'success' ? <Check size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> : <AlertTriangle size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />}
            {msg}
          </span>
          {showPayrollLink && msgType === 'success' && typeof setPage === 'function' && (
            <button onClick={() => setPage('Payroll')} style={{ background: P, color: '#fff', border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Run Payroll →
            </button>
          )}
        </div>
      )}

      {/* Month/year selector + KPIs row */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 24, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ ...CARD, padding: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 4 }}>MONTH</label>
            <select value={month} onChange={e => setMonth(parseInt(e.target.value))}
              style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '6px 10px', fontSize: 14, fontWeight: 600, outline: 'none' }}>
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 4 }}>YEAR</label>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))}
              style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: '6px 10px', fontSize: 14, fontWeight: 600, outline: 'none' }}>
              {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 18, padding: '7px 12px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', cursor: 'pointer', fontSize: 13, color: P }}>
            <RefreshCw size={13} /> Load
          </button>
        </div>

        {[
          { label: 'Total Employees', value: records.length,          color: P,         icon: Users },
          { label: 'Synced',          value: syncedCount,             color: '#10b981', icon: Check },
          { label: 'Pending Sync',    value: pendingCount,            color: '#f59e0b', icon: Clock },
          { label: 'Mid-Month Joiners', value: midMonthCount,         color: '#0369a1', icon: UserPlus },
          { label: 'Total OT Hours',  value: `${totalOT.toFixed(0)}h`, color: '#6B3FDB', icon: Zap },
        ].map(k => (
          <div key={k.label} style={{ ...CARD, padding: 16, display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 130 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: `${k.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <k.icon size={18} color={k.color} />
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Freeze / frozen status banners */}
      {!isFrozen && pendingCount > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '14px 16px', marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <AlertCircle size={16} color="#d97706" style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#92400e' }}>Ready to Freeze Attendance</div>
            <div style={{ fontSize: 12, color: '#92400e', marginTop: 3 }}>
              Once frozen, attendance records become <strong>immutable</strong>. Only a Super Admin can unfreeze.
              Payroll calculations will use frozen data only. Please verify all records before proceeding.
            </div>
          </div>
        </div>
      )}
      {isFrozen && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '14px 16px', marginBottom: 20, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Lock size={16} color="#15803d" />
            <div style={{ fontSize: 13, color: '#15803d', fontWeight: 600 }}>
              Attendance for {MONTHS[month - 1]} {year} is frozen and synced to payroll. Records are now immutable.
            </div>
          </div>
          <button
            onClick={() => setShowForceConfirm(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
            <RefreshCw size={12} /> Force Re-sync
          </button>
        </div>
      )}

      {/* Mid-month joiner notice */}
      {midMonthCount > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
          <UserPlus size={15} color="#1d4ed8" style={{ flexShrink: 0 }} />
          <div style={{ fontSize: 12, color: '#1e40af' }}>
            <strong>{midMonthCount} mid-month joiner{midMonthCount > 1 ? 's' : ''}</strong> detected. Working days have been prorated from their joining date to month-end.
          </div>
        </div>
      )}

      {/* Action bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        {!isFrozen && (
          <>
            <button onClick={selectAll}
              style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}>
              {selected.size === pendingCount && pendingCount > 0 ? 'Deselect All' : 'Select All Pending'}
            </button>
            <button onClick={() => setShowConfirm(true)}
              disabled={syncing || records.length === 0}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 8, border: 'none',
                background: records.length === 0 ? '#d1d5db' : '#10b981', color: '#fff', fontWeight: 600, fontSize: 14,
                cursor: syncing || records.length === 0 ? 'not-allowed' : 'pointer', opacity: syncing ? 0.7 : 1 }}>
              <Lock size={14} /> {syncing ? 'Freezing…' : selected.size > 0 ? `Freeze ${selected.size} Selected` : 'Freeze & Sync All'}
            </button>
          </>
        )}
      </div>

      {/* Records table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading attendance data…</div>
      ) : records.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <IndianRupee size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: 0 }}>No attendance records for {MONTHS[month - 1]} {year}</p>
        </div>
      ) : (
        <div style={CARD}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #f0f0f4' }}>
                {!isFrozen && <th style={{ padding: '10px 12px', width: 36 }}></th>}
                {['Employee', 'Department', 'Present', 'Absent', 'Late', 'Working Days', 'Total Hours', 'OT Hours', 'Status'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr key={r.employee_id} style={{ borderBottom: '1px solid #f9f9f9', background: r.payroll_synced ? '#f0fdf420' : '#fff' }}>
                  {!isFrozen && (
                    <td style={{ padding: '10px 12px' }}>
                      {!r.payroll_synced && (
                        <input type="checkbox" checked={selected.has(r.employee_id)} onChange={() => toggleSelect(r.employee_id)} style={{ accentColor: P }} />
                      )}
                    </td>
                  )}
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {r.employee_name}
                      {r.is_mid_month_joiner && (
                        <span style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <UserPlus size={9} /> Joiner
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.designation}</div>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>{r.department}</td>
                  <td style={{ padding: '10px 12px', color: '#10b981', fontWeight: 500 }}>{r.present_days}</td>
                  <td style={{ padding: '10px 12px', color: r.absent_days > 0 ? '#ef4444' : '#9ca3af', fontWeight: r.absent_days > 0 ? 600 : 400 }}>{r.absent_days}</td>
                  <td style={{ padding: '10px 12px', color: r.late_days > 0 ? '#f59e0b' : '#9ca3af' }}>{r.late_days}</td>
                  <td style={{ padding: '10px 12px' }}>
                    {r.is_mid_month_joiner ? (
                      <span title={`Prorated from joining date (full month: ${r.working_days} days)`}>
                        <span style={{ fontWeight: 600, color: '#1d4ed8' }}>{r.prorated_working_days}</span>
                        <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>/ {r.working_days}</span>
                      </span>
                    ) : (
                      <span style={{ color: '#374151' }}>{r.working_days}</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 500 }}>{parseFloat(r.total_hours || 0).toFixed(1)}h</td>
                  <td style={{ padding: '10px 12px', color: parseFloat(r.total_ot_hours) > 0 ? P : '#9ca3af', fontWeight: parseFloat(r.total_ot_hours) > 0 ? 600 : 400 }}>
                    {parseFloat(r.total_ot_hours || 0).toFixed(1)}h
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    {r.payroll_synced
                      ? <span style={{ background: '#f0fdf4', color: '#15803d', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Lock size={9} />Frozen</span>
                      : <span style={{ background: '#fffbeb', color: '#d97706', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>Pending</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Freeze confirm dialog */}
      {showConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 420, width: '100%' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
              <Lock size={24} color="#10b981" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <h3 style={{ margin: '0 0 6px', fontSize: 17 }}>Confirm Attendance Freeze</h3>
                <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
                  You are about to freeze attendance for <strong>{MONTHS[month - 1]} {year}</strong>.
                  {selected.size > 0
                    ? ` Selected ${selected.size} employees.`
                    : ` All ${records.filter(r => !r.payroll_synced).length} pending employees will be frozen.`}
                </p>
              </div>
            </div>
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 12, color: '#dc2626' }}>
              <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              <strong>This action is irreversible.</strong> Frozen records cannot be edited. Only Super Admins can unfreeze.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowConfirm(false)} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
              <button onClick={() => handleSync(false)} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#10b981', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Lock size={14} /> Freeze & Sync
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Force re-sync confirm dialog */}
      {showForceConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 440, width: '100%' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
              <RefreshCw size={24} color="#dc2626" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <h3 style={{ margin: '0 0 6px', fontSize: 17 }}>Force Re-sync Attendance</h3>
                <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
                  This will override the frozen sync for <strong>{MONTHS[month - 1]} {year}</strong> and re-push all attendance data to payroll, even for already-frozen employees.
                </p>
              </div>
            </div>
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 12, color: '#dc2626' }}>
              <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              <strong>Supervisor action required.</strong> Force re-sync overwrites existing payroll sync data. Use only when attendance corrections were made after the initial freeze. This will be logged in the audit trail.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForceConfirm(false)} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
              <button onClick={() => handleSync(true)} disabled={syncing}
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontWeight: 600, cursor: syncing ? 'not-allowed' : 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, opacity: syncing ? 0.7 : 1 }}>
                <RefreshCw size={14} /> {syncing ? 'Re-syncing…' : 'Force Re-sync'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
