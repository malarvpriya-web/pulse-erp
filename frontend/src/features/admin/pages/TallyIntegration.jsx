// frontend/src/features/admin/pages/TallyIntegration.jsx
import { useState, useEffect, useCallback } from 'react';
import { BarChart2, RefreshCw, AlertCircle, Settings } from 'lucide-react';
import api from '@/services/api/client';

function formatINR(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '₹0';
  if (num >= 100000) return `₹${(num/100000).toFixed(2)}L`;
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}

function timeAgo(iso) {
  if (!iso) return 'Never';
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const DEFAULT_STATUS = {
  connected: false,
  tally_url: '',
  ledger_count: 0,
  stats: { total_vouchers: 0, synced_invoices: 0, synced_payments: 0, last_error_count: 0 },
  last_sync: null,
};

const DEFAULT_CONFIG = {
  tally_url: '',
  company: '',
  fy_start: '2025-04-01',
  fy_end:   '2026-03-31',
};

export default function TallyIntegration() {
  const [status, setStatus]     = useState(DEFAULT_STATUS);
  const [unsynced, setUnsynced] = useState([]);
  const [errors, setErrors]     = useState([]);
  const [loading, setLoading]   = useState(false);
  const [syncing, setSyncing]   = useState(false);
  const [syncJob, setSyncJob]   = useState(null);
  const [tab, setTab]           = useState('status');
  const [config, setConfig]     = useState(DEFAULT_CONFIG);
  const [savingConfig, setSavingConfig] = useState(false);
  const [msg, setMsg]           = useState({ text: '', type: '' });
  const [configLoaded, setConfigLoaded] = useState(false);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 4000);
  };

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, unsyncedRes, errorsRes, configRes] = await Promise.all([
        api.get('/integrations/tally/sync-status').catch(() => null),
        api.get('/integrations/tally/unsynced').catch(() => null),
        api.get('/integrations/tally/errors').catch(() => null),
        api.get('/settings/tally').catch(() => null),
      ]);

      if (statusRes?.data) {
        setStatus(prev => ({
          ...DEFAULT_STATUS,
          ...prev,
          ...statusRes.data,
          stats: { ...DEFAULT_STATUS.stats, ...(statusRes.data.stats || {}) },
        }));
      }
      if (unsyncedRes?.data) {
        setUnsynced(Array.isArray(unsyncedRes.data) ? unsyncedRes.data : unsyncedRes.data.items || []);
      }
      if (errorsRes?.data) {
        setErrors(Array.isArray(errorsRes.data) ? errorsRes.data : errorsRes.data.errors || []);
      }
      if (configRes?.data && !configLoaded) {
        const d = configRes.data;
        setConfig({
          tally_url: d.tally_url || '',
          company:   d.company_name || '',
          fy_start:  d.fy_start ? d.fy_start.split('T')[0] : DEFAULT_CONFIG.fy_start,
          fy_end:    d.fy_end   ? d.fy_end.split('T')[0]   : DEFAULT_CONFIG.fy_end,
        });
        setConfigLoaded(true);
      }
    } catch {
      // keep existing state — page never crashes
    } finally {
      setLoading(false);
    }
  }, [configLoaded]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  /* poll sync job progress */
  useEffect(() => {
    if (!syncJob) return;
    const iv = setInterval(async () => {
      try {
        const res = await api.get('/integrations/tally/sync-status');
        const d = res?.data;
        if (d?.last_sync) {
          setSyncJob(null);
          flash('Tally sync completed');
          loadStatus();
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(iv);
  }, [syncJob, loadStatus]);

  const runSync = async (type = 'all') => {
    setSyncing(true);
    try {
      const res = await api.post(`/integrations/tally/sync-${type}`).catch(e => {
        throw new Error(e.response?.data?.message || 'Sync failed — is Tally running?');
      });
      setSyncJob({ job_id: res.data?.job_id, progress_pct: 0, message: 'Sync started…' });
      flash('Sync job started');
    } catch (e) {
      flash(e.message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const syncSingle = async (item) => {
    try {
      await api.post('/integrations/tally/sync-voucher', { type: item.type.toLowerCase(), id: item.id });
      setUnsynced(prev => prev.filter(x => x.id !== item.id));
      flash(`Synced ${item.reference}`);
    } catch (e) {
      flash(e.response?.data?.message || e.message, 'error');
    }
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      await api.post('/settings/tally', {
        tally_url:    config.tally_url,
        company_name: config.company,
        fy_start:     config.fy_start,
        fy_end:       config.fy_end,
      });
      flash('Configuration saved');
      setConfigLoaded(false); // reload on next loadStatus
      loadStatus();
    } catch (e) {
      flash(e.response?.data?.error || e.message, 'error');
    } finally {
      setSavingConfig(false);
    }
  };

  const tabStyle = (t) => ({
    padding: '8px 18px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
    background:   tab === t ? '#6B3FDB' : 'transparent',
    color:        tab === t ? '#fff'    : '#6B3FDB',
    borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent',
  });

  const pendingCount = unsynced.filter(u => u.status === 'pending').length;
  const errorCount   = unsynced.filter(u => u.status === 'error').length;

  /* ── unconfigured empty state ── */
  if (!loading && !status.connected && !status.tally_url && !configLoaded) {
    return (
      <div style={{ padding: 24, background: '#fff', minHeight: '100vh' }}>
        <div className="page-header" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BarChart2 size={22} color="var(--color-text-primary, #111827)" />
            <div>
              <h1 className="page-title" style={{ margin: 0 }}>Tally Integration</h1>
              <p className="page-subtitle" style={{ margin: 0 }}>Sync vouchers, ledgers and transactions with Tally ERP 9 / TallyPrime</p>
            </div>
          </div>
        </div>
        <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center', padding: 40, background: '#f5f3ff', borderRadius: 16, border: '2px dashed #c4b5fd' }}>
          <Settings size={48} color="#6B3FDB" style={{ marginBottom: 16 }} />
          <h2 style={{ margin: '0 0 10px', color: '#4c1d95', fontSize: 20 }}>Tally integration isn't set up yet</h2>
          <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 24 }}>
            Configure your Tally server connection to start syncing vouchers, invoices, and payments.
          </p>
          <button
            onClick={() => setTab('config')}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 28px', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
            Configure Tally
          </button>
        </div>
        {tab === 'config' && renderConfigPanel()}
      </div>
    );
  }

  function renderConfigPanel() {
    return (
      <div style={{ maxWidth: 480, margin: '24px auto' }}>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0 }}>
          Configure the Tally TDL Gateway connection. Ensure the TDL gateway server is running on your Tally machine.
        </p>
        {[
          { key: 'tally_url', label: 'Tally Gateway URL',    type: 'text', placeholder: 'http://localhost:9000', hint: 'IP/hostname of the machine running Tally TDL server' },
          { key: 'company',   label: 'Tally Company Name',   type: 'text', placeholder: 'Manifest Technologies Pvt Ltd', hint: 'Must match exactly as shown in Tally' },
          { key: 'fy_start',  label: 'Financial Year Start', type: 'date', placeholder: '', hint: '' },
          { key: 'fy_end',    label: 'Financial Year End',   type: 'date', placeholder: '', hint: '' },
        ].map(f => (
          <div key={f.key} style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>{f.label}</label>
            <input
              type={f.type}
              placeholder={f.placeholder}
              value={config[f.key] || ''}
              onChange={e => setConfig(c => ({ ...c, [f.key]: e.target.value }))}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}
            />
            {f.hint && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{f.hint}</div>}
          </div>
        ))}
        <div style={{ padding: '12px 14px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 12, color: '#92400e' }}>
            <strong>Setup:</strong> Install the TDL Gateway on your Tally server machine. Run{' '}
            <code style={{ background: '#fde68a', padding: '1px 4px', borderRadius: 3 }}>node gateway/tally-tdl-server.js</code>{' '}
            and ensure port 9000 is accessible.
          </p>
        </div>
        <button
          onClick={saveConfig}
          disabled={savingConfig}
          style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
          {savingConfig ? 'Saving…' : 'Save Configuration'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, background: '#fff', minHeight: '100vh' }}>
      {/* header */}
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BarChart2 size={22} color="var(--color-text-primary, #111827)" />
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>Tally Integration</h1>
            <p className="page-subtitle" style={{ margin: 0 }}>Sync vouchers, ledgers and transactions with Tally ERP 9 / TallyPrime</p>
          </div>
        </div>
      </div>

      {/* flash */}
      {msg.text && (
        <div style={{
          marginBottom: 14, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 13,
          background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      msg.type === 'error' ? '#dc2626' : '#16a34a',
          border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
        }}>
          {msg.text}
        </div>
      )}

      {/* ── CONNECTION STATUS CARD ── */}
      <div style={{
        background: '#fff',
        border: `2px solid ${status.connected ? '#16a34a' : '#dc2626'}`,
        borderRadius: 12, padding: 20, marginBottom: 20,
        display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 240 }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: status.connected ? '#d1fae5' : '#fee2e2',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {status.connected
              ? <RefreshCw size={22} color="#16a34a" />
              : <AlertCircle size={22} color="#dc2626" />}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: status.connected ? '#16a34a' : '#dc2626' }}>
              {status.connected ? 'Connected to Tally' : 'Tally Not Reachable'}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{status.tally_url}</div>
            {status.tally_version && <div style={{ fontSize: 11, color: '#9ca3af' }}>Version: {status.tally_version}</div>}
            {status.connection_error && <div style={{ fontSize: 11, color: '#dc2626', marginTop: 2 }}>{status.connection_error}</div>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {[
            { label: 'Last Sync',       value: status.last_sync ? timeAgo(status.last_sync) : 'Never', color: '#374151' },
            { label: 'Ledgers',         value: status.ledger_count || 0,                               color: '#6B3FDB' },
            { label: 'Invoices Synced', value: status.stats?.synced_invoices || 0,                     color: '#16a34a' },
            { label: 'Pending',         value: pendingCount, color: pendingCount > 0 ? '#d97706' : '#16a34a' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ textAlign: 'center', minWidth: 70 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
              <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{label}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            onClick={() => runSync('all')}
            disabled={syncing}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 700, fontSize: 13, opacity: syncing ? 0.6 : 1 }}>
            {syncing ? '⟳ Syncing…' : '↺ Sync All Now'}
          </button>
          <button
            onClick={loadStatus}
            disabled={loading}
            style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '7px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            {loading ? 'Checking…' : '▶ Test Connection'}
          </button>
        </div>
      </div>

      {/* sync progress bar */}
      {syncJob && (
        <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#6B3FDB' }}>Sync in progress…</span>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Job ID: {syncJob.job_id}</span>
          </div>
          <div style={{ height: 8, background: '#e9e4ff', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: '#6B3FDB', borderRadius: 4, width: '60%', animation: 'pulse 1.5s ease-in-out infinite' }} />
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{syncJob.message}</div>
        </div>
      )}

      {/* ── TABS ── */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e9e4ff', background: '#fff', borderRadius: '10px 10px 0 0', padding: '0 8px' }}>
        {[
          ['status',   'Sync Status'],
          ['unsynced', `Unsynced (${pendingCount + errorCount})`],
          ['errors',   `Error Log (${errors.length})`],
          ['config',   'Config'],
        ].map(([k, l]) => (
          <button key={k} style={tabStyle(k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 0 10px 10px', padding: 20 }}>

        {/* ── STATUS TAB ── */}
        {tab === 'status' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 14, marginBottom: 20 }}>
              {[
                { label: 'Total Vouchers Pushed', value: status.stats?.total_vouchers   || 0, color: '#6B3FDB', bg: '#ede9fe' },
                { label: 'Invoices Synced',        value: status.stats?.synced_invoices  || 0, color: '#16a34a', bg: '#d1fae5' },
                { label: 'Payments Synced',        value: status.stats?.synced_payments  || 0, color: '#2563eb', bg: '#dbeafe' },
                { label: 'Pending Sync',           value: pendingCount,                         color: '#d97706', bg: '#fef3c7' },
                { label: 'Sync Errors',            value: status.stats?.last_error_count || errorCount, color: '#dc2626', bg: '#fee2e2' },
                { label: 'Ledgers in Tally',       value: status.ledger_count || 0,             color: '#374151', bg: '#f3f4f6' },
              ].map(({ label, value, color, bg }) => (
                <div key={label} style={{ padding: '14px 16px', background: bg, borderRadius: 10 }}>
                  <div style={{ fontSize: 26, fontWeight: 800, color }}>{value}</div>
                  <div style={{ fontSize: 12, color: '#374151', fontWeight: 600, marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            <div style={{ padding: '14px 16px', background: '#f5f3ff', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, color: '#4c1d95', marginBottom: 10 }}>Sync Schedule</div>
              {[
                { label: 'Invoices',    schedule: 'Auto-pushed 5 min after creation / update' },
                { label: 'Payments',   schedule: 'Auto-pushed after Razorpay webhook verification' },
                { label: 'Full Sync',  schedule: 'Manual only — use "Sync All Now" button' },
                { label: 'Ledger Pull', schedule: 'Daily at 6:00 AM IST (via cron)' },
              ].map(({ label, schedule }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #e9e4ff', fontSize: 13 }}>
                  <span style={{ fontWeight: 600, color: '#374151' }}>{label}</span>
                  <span style={{ color: '#6b7280' }}>{schedule}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── UNSYNCED TAB ── */}
        {tab === 'unsynced' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{unsynced.length} transactions awaiting sync</span>
              <button
                onClick={() => runSync('all')}
                disabled={syncing}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                {syncing ? 'Syncing…' : '↺ Sync All'}
              </button>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Type', 'Reference', 'Party', 'Amount', 'Date', 'Status', ''].map(h => (
                    <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unsynced.map(item => (
                  <tr key={item.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                        background: item.type === 'Invoice' ? '#dbeafe' : '#d1fae5',
                        color:      item.type === 'Invoice' ? '#2563eb' : '#16a34a',
                      }}>
                        {item.type}
                      </span>
                    </td>
                    <td style={{ padding: '9px 12px', fontWeight: 600, color: '#6B3FDB' }}>{item.reference}</td>
                    <td style={{ padding: '9px 12px' }}>{item.party}</td>
                    <td style={{ padding: '9px 12px', fontWeight: 700 }}>{formatINR(item.amount)}</td>
                    <td style={{ padding: '9px 12px', color: '#6b7280' }}>{item.date}</td>
                    <td style={{ padding: '9px 12px' }}>
                      {item.status === 'error'
                        ? <div>
                            <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#fee2e2', color: '#dc2626' }}>Error</span>
                            <div style={{ fontSize: 10, color: '#dc2626', marginTop: 3 }}>{item.error}</div>
                          </div>
                        : <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#fef3c7', color: '#d97706' }}>Pending</span>
                      }
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <button
                        onClick={() => syncSingle(item)}
                        style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 7, padding: '4px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                        Sync
                      </button>
                    </td>
                  </tr>
                ))}
                {unsynced.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>All transactions are synced with Tally</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* ── ERROR LOG TAB ── */}
        {tab === 'errors' && (
          <div>
            {errors.length === 0
              ? <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No sync errors recorded</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {errors.map(err => (
                    <div key={err.id} style={{ padding: '12px 14px', background: '#fff5f5', border: '1px solid #fecaca', borderLeft: '4px solid #dc2626', borderRadius: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, color: '#dc2626', fontSize: 12 }}>{err.voucher_type} — {err.reference}</span>
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>{timeAgo(err.created_at)}</span>
                      </div>
                      <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>{err.message}</p>
                    </div>
                  ))}
                </div>
              )
            }
          </div>
        )}

        {/* ── CONFIG TAB ── */}
        {tab === 'config' && renderConfigPanel()}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }`}</style>
    </div>
  );
}
