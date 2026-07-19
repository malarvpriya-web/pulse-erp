import { useState, useEffect, useCallback } from 'react';
import { PenLine, FileCheck, Clock, AlertCircle, RefreshCw, Send, ArrowLeft, CheckCircle, RotateCcw, Eye, EyeOff, Plug } from 'lucide-react';
import api from '@/services/api/client';
import './ZohoSignIntegration.css';

const STATUS_MAP = {
  inprogress: { label: 'In Progress', bg: '#dbeafe', color: '#1d4ed8' },
  completed:  { label: 'Completed',   bg: '#dcfce7', color: '#15803d' },
  recalled:   { label: 'Recalled',    bg: '#fee2e2', color: '#dc2626' },
  expired:    { label: 'Expired',     bg: '#fef3c7', color: '#d97706' },
  draft:      { label: 'Draft',       bg: '#f3f4f6', color: '#6b7280' },
};

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function StatusPill({ status }) {
  const s = STATUS_MAP[status?.toLowerCase()] || { label: status || 'Unknown', bg: '#f3f4f6', color: '#6b7280' };
  return (
    <span className="zsi-pill" style={{ background: s.bg, color: s.color }}>{s.label}</span>
  );
}

const EMPTY_CFG = {
  ZOHO_SIGN_CLIENT_ID: '',
  ZOHO_SIGN_CLIENT_SECRET: '',
  ZOHO_SIGN_ACCESS_TOKEN: '',
  ZOHO_SIGN_REFRESH_TOKEN: '',
  ZOHO_SIGN_DC: 'IN',
};

const DC_OPTIONS = ['IN', 'US', 'EU', 'AU'];

export default function ZohoSignIntegration({ setPage }) {
  const [status, setStatus]       = useState(null);
  const [requests, setRequests]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [syncing, setSyncing]     = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab]             = useState('overview');
  const [cfg, setCfg]             = useState(EMPTY_CFG);
  const [savingCfg, setSavingCfg] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [toast, setToast]         = useState(null);
  const [sendForm, setSendForm]   = useState(null);
  const [sending, setSending]     = useState(false);
  const [showPwd, setShowPwd]     = useState({});

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [stRes, reqRes] = await Promise.all([
        api.get('/integrations/zoho-sign/status').catch(() => ({ data: { configured: false } })),
        api.get('/integrations/zoho-sign/requests').catch(() => ({ data: { requests: [] } })),
      ]);
      setStatus(stRes.data);
      setRequests(reqRes.data.requests || []);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await api.get('/integrations/config/zoho-sign');
      const creds = res.data?.credentials || {};
      setCfg({
        ZOHO_SIGN_CLIENT_ID:     creds.ZOHO_SIGN_CLIENT_ID     || '',
        ZOHO_SIGN_CLIENT_SECRET: creds.ZOHO_SIGN_CLIENT_SECRET || '',
        ZOHO_SIGN_ACCESS_TOKEN:  creds.ZOHO_SIGN_ACCESS_TOKEN  || '',
        ZOHO_SIGN_REFRESH_TOKEN: creds.ZOHO_SIGN_REFRESH_TOKEN || '',
        ZOHO_SIGN_DC:            creds.ZOHO_SIGN_DC            || 'IN',
      });
    } catch {
      // keep defaults
    }
  }, []);

  useEffect(() => { loadData(); loadConfig(); }, [loadData, loadConfig]);

  const isConnected = status?.connected === true;

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.post('/integrations/zoho-sign/sync');
      const d = res.data;
      showToast(d.simulated ? 'Configure credentials to enable live sync' : `Synced ${d.synced} of ${d.checked} documents`);
      loadData();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleRefreshToken = async () => {
    setRefreshing(true);
    try {
      await api.post('/integrations/zoho-sign/refresh-token');
      showToast('Access token refreshed successfully');
      loadData();
    } catch (err) {
      showToast(err.response?.data?.error || 'Token refresh failed', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveCfg = async () => {
    setSavingCfg(true);
    try {
      await api.put('/integrations/config/zoho-sign', cfg);
      showToast('Configuration saved');
      loadData();
      loadConfig(); // refresh masked display
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to save configuration', 'error');
    } finally {
      setSavingCfg(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    try {
      const res = await api.post('/integrations/zoho-sign/test-connection', cfg);
      const d = res.data;
      if (d.connected) {
        showToast(`Connected to Zoho Sign (${d.dc} data center) — ${d.total_requests} requests`);
        setStatus(s => ({ ...s, connected: true, configured: true, dc: d.dc, total_requests: d.total_requests }));
      } else {
        showToast(d.message || 'Connection test failed', 'error');
      }
    } catch (err) {
      showToast(err.response?.data?.message || 'Connection test failed — check your credentials', 'error');
    } finally {
      setTestingConn(false);
    }
  };

  const handleSend = async () => {
    if (!sendForm?.title || !sendForm?.recipient_email) {
      showToast('Title and recipient email are required', 'error');
      return;
    }
    setSending(true);
    try {
      const res = await api.post('/integrations/zoho-sign/requests', sendForm);
      const d = res.data;
      showToast(d.simulated ? 'Demo mode — configure credentials to send real requests' : 'Document sent for signing via Zoho Sign');
      setSendForm(null);
      loadData();
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const togglePwd = key => setShowPwd(s => ({ ...s, [key]: !s[key] }));

  const total     = requests.length;
  const completed = requests.filter(r => r.request_status?.toLowerCase() === 'completed').length;
  const pending   = requests.filter(r => r.request_status?.toLowerCase() === 'inprogress').length;
  const expired   = requests.filter(r => r.request_status?.toLowerCase() === 'expired').length;

  const CFG_FIELDS = [
    { key: 'ZOHO_SIGN_CLIENT_ID',     label: 'Client ID',     secret: false, ph: '1000.XXXXXXXXXXXXXXXXXX' },
    { key: 'ZOHO_SIGN_CLIENT_SECRET', label: 'Client Secret', secret: true,  ph: 'Paste your Client Secret' },
    { key: 'ZOHO_SIGN_ACCESS_TOKEN',  label: 'Access Token',  secret: true,  ph: 'Paste your Access Token' },
    { key: 'ZOHO_SIGN_REFRESH_TOKEN', label: 'Refresh Token', secret: true,  ph: 'Paste your Refresh Token' },
  ];

  return (
    <div className="zsi-root">
      {toast && (
        <div className={`zsi-toast zsi-toast-${toast.type}`}>{toast.msg}</div>
      )}

      {/* Header — standard white/light theme */}
      <div className="zsi-header">
        <div className="zsi-header-left">
          <button className="zsi-back-btn" onClick={() => setPage?.('IntegrationsHub')}>
            <ArrowLeft size={16} />
          </button>
          <div className="zsi-header-icon">
            <PenLine size={20} />
          </div>
          <div>
            <h1 className="zsi-title">Zoho Sign Integration</h1>
            <p className="zsi-sub">E-signature workflow management via Zoho Sign API</p>
          </div>
        </div>
        <div className="zsi-header-right">
          <div className={`zsi-conn-dot ${isConnected ? 'connected' : ''}`} />
          <span className="zsi-conn-label">{isConnected ? `Connected · ${status.dc}` : 'Not Connected'}</span>
          <button
            className="zsi-hdr-btn"
            onClick={handleSync}
            disabled={syncing || !isConnected}
            title={!isConnected ? 'Complete configuration to enable' : undefined}
          >
            <RefreshCw size={14} className={syncing ? 'zsi-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync Status'}
          </button>
          <button
            className="zsi-hdr-btn primary"
            onClick={() => setSendForm({ title: '', recipient_name: '', recipient_email: '', message: '', expiry_days: 7 })}
            disabled={!isConnected}
            title={!isConnected ? 'Complete configuration to enable' : undefined}
          >
            <Send size={14} /> Send for Signing
          </button>
        </div>
      </div>

      <div className="zsi-body">
        {/* KPI row */}
        <div className="zsi-kpis">
          {[
            { icon: <FileCheck size={20} />, val: total,     label: 'Total Requests', color: '#4f46e5', bg: '#eef2ff' },
            { icon: <CheckCircle size={20} />, val: completed, label: 'Completed',     color: '#15803d', bg: '#dcfce7' },
            { icon: <Clock size={20} />,      val: pending,   label: 'In Progress',   color: '#1d4ed8', bg: '#dbeafe' },
            { icon: <AlertCircle size={20} />, val: expired,  label: 'Expired',       color: '#d97706', bg: '#fef3c7' },
          ].map(k => (
            <div key={k.label} className="zsi-kpi">
              <div className="zsi-kpi-icon" style={{ background: k.bg, color: k.color }}>{k.icon}</div>
              <div className="zsi-kpi-val">{k.val}</div>
              <div className="zsi-kpi-lbl">{k.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="zsi-tabs">
          {[['overview', 'Overview'], ['requests', 'Signing Requests'], ['config', 'Configuration']].map(([id, label]) => (
            <button key={id} className={`zsi-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        {/* Overview tab */}
        {tab === 'overview' && (
          <div className="zsi-overview">
            <div className="zsi-status-card">
              <h3 className="zsi-card-title">Connection Status</h3>
              <div className="zsi-status-rows">
                <div className="zsi-status-row">
                  <span className="zsi-status-lbl">Status</span>
                  <span className={`zsi-status-val ${isConnected ? 'green' : 'amber'}`}>
                    {isConnected ? '✓ Connected' : status?.configured ? '✗ Auth Failed' : '⚠ Not Configured'}
                  </span>
                </div>
                {status?.dc && (
                  <div className="zsi-status-row">
                    <span className="zsi-status-lbl">Data Center</span>
                    <span className="zsi-status-val">{status.dc}</span>
                  </div>
                )}
                {status?.error && (
                  <div className="zsi-status-row">
                    <span className="zsi-status-lbl">Error</span>
                    <span className="zsi-status-val red">{status.error}</span>
                  </div>
                )}
                {status?.total_requests !== undefined && (
                  <div className="zsi-status-row">
                    <span className="zsi-status-lbl">Total Requests in Zoho Sign</span>
                    <span className="zsi-status-val">{status.total_requests}</span>
                  </div>
                )}
              </div>
              {status?.configured && (
                <button className="zsi-refresh-btn" onClick={handleRefreshToken} disabled={refreshing}>
                  <RotateCcw size={13} className={refreshing ? 'zsi-spin' : ''} />
                  {refreshing ? 'Refreshing…' : 'Refresh Access Token'}
                </button>
              )}
            </div>

            <div className="zsi-howto-card">
              <h3 className="zsi-card-title">Setup Guide</h3>
              <ol className="zsi-steps">
                <li>Go to <strong>api-console.zoho.in</strong> → Create a Server-based OAuth app</li>
                <li>Add scope: <code>ZohoSign.documents.ALL</code></li>
                <li>Generate tokens using the OAuth authorization code flow</li>
                <li>Enter credentials in the <strong>Configuration</strong> tab</li>
                <li>Set <strong>Data Center</strong> to <code>IN</code> (India), <code>US</code>, <code>EU</code>, or <code>AU</code></li>
                <li>Click <strong>Test Connection</strong> to verify — then Save</li>
              </ol>
            </div>
          </div>
        )}

        {/* Requests tab */}
        {tab === 'requests' && (
          <div className="zsi-table-wrap">
            {loading ? (
              <div className="zsi-loading"><div className="zsi-spinner" /></div>
            ) : requests.length === 0 ? (
              <div className="zsi-empty">
                <PenLine size={36} />
                <p>{status?.configured ? 'No signing requests found in Zoho Sign' : 'Configure credentials to view signing requests'}</p>
              </div>
            ) : (
              <table className="zsi-table">
                <thead>
                  <tr>
                    <th>Document Name</th>
                    <th>Recipient</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map(r => (
                    <tr key={r.request_id}>
                      <td className="zsi-doc-name">{r.request_name || '—'}</td>
                      <td>{r.actions?.[0]?.recipient_email || r.owner_email || '—'}</td>
                      <td><StatusPill status={r.request_status} /></td>
                      <td>{fmt(r.created_time)}</td>
                      <td>{fmt(r.expiration_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Config tab */}
        {tab === 'config' && (
          <div className="zsi-cfg-card">
            <h3 className="zsi-card-title">OAuth Credentials</h3>
            <p className="zsi-cfg-note">
              Credentials are stored securely per company. After saving, click <strong>Test Connection</strong> to verify.
            </p>
            <div className="zsi-cfg-grid">
              {CFG_FIELDS.map(f => {
                const isSaved = f.secret && cfg[f.key] === '***';
                return (
                  <div key={f.key} className="zsi-field">
                    <label className="zsi-label">{f.label}</label>
                    <div className="zsi-input-wrap">
                      <input
                        type={f.secret && !showPwd[f.key] ? 'password' : 'text'}
                        className="zsi-input"
                        placeholder={isSaved ? 'Saved — leave blank to keep' : f.ph}
                        value={isSaved ? '' : (cfg[f.key] || '')}
                        onChange={e => setCfg(c => ({ ...c, [f.key]: e.target.value }))}
                      />
                      {f.secret && (
                        <button
                          type="button"
                          className="zsi-eye-btn"
                          onClick={() => togglePwd(f.key)}
                          title={showPwd[f.key] ? 'Hide' : 'Show'}
                        >
                          {showPwd[f.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Data Center — dropdown */}
              <div className="zsi-field">
                <label className="zsi-label">Data Center</label>
                <select
                  className="zsi-input zsi-select"
                  value={cfg.ZOHO_SIGN_DC}
                  onChange={e => setCfg(c => ({ ...c, ZOHO_SIGN_DC: e.target.value }))}
                >
                  {DC_OPTIONS.map(dc => (
                    <option key={dc} value={dc}>
                      {dc === 'IN' ? 'IN — India (default)' : dc === 'US' ? 'US — United States' : dc === 'EU' ? 'EU — Europe' : 'AU — Australia'}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="zsi-cfg-actions">
              <button className="zsi-save-btn" onClick={handleSaveCfg} disabled={savingCfg}>
                {savingCfg ? 'Saving…' : 'Save Configuration'}
              </button>
              <button className="zsi-test-btn" onClick={handleTestConnection} disabled={testingConn}>
                <Plug size={13} className={testingConn ? 'zsi-spin' : ''} />
                {testingConn ? 'Testing…' : 'Test Connection'}
              </button>
              <button className="zsi-refresh-btn" onClick={handleRefreshToken} disabled={refreshing}>
                <RotateCcw size={13} className={refreshing ? 'zsi-spin' : ''} />
                {refreshing ? 'Refreshing…' : 'Refresh Token Now'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Send for signing modal */}
      {sendForm && (
        <div className="zsi-overlay" onClick={() => setSendForm(null)}>
          <div className="zsi-modal" onClick={e => e.stopPropagation()}>
            <div className="zsi-modal-hd">
              <span>Send Document for Signing</span>
              <button className="zsi-modal-close" onClick={() => setSendForm(null)}>✕</button>
            </div>
            <div className="zsi-modal-body">
              {[
                { key: 'title',           label: 'Document Title',     type: 'text',   ph: 'e.g. NDA — Vendor Agreement' },
                { key: 'recipient_name',  label: 'Recipient Name',     type: 'text',   ph: 'John Smith' },
                { key: 'recipient_email', label: 'Recipient Email',    type: 'email',  ph: 'john@example.com' },
                { key: 'expiry_days',     label: 'Expiry (days)',      type: 'number', ph: '7' },
              ].map(f => (
                <div key={f.key} className="zsi-field">
                  <label className="zsi-label">{f.label}</label>
                  <input
                    type={f.type}
                    className="zsi-input"
                    placeholder={f.ph}
                    value={sendForm[f.key] || ''}
                    onChange={e => setSendForm(s => ({ ...s, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="zsi-field">
                <label className="zsi-label">Message (optional)</label>
                <textarea
                  className="zsi-textarea"
                  rows={3}
                  placeholder="Please review and sign this document at your earliest convenience."
                  value={sendForm.message || ''}
                  onChange={e => setSendForm(s => ({ ...s, message: e.target.value }))}
                />
              </div>
              {!status?.configured && (
                <div className="zsi-demo-notice">
                  <AlertCircle size={14} /> Demo mode — configure Zoho Sign credentials to send real requests
                </div>
              )}
            </div>
            <div className="zsi-modal-ft">
              <button className="zsi-btn-cancel" onClick={() => setSendForm(null)}>Cancel</button>
              <button className="zsi-btn-send" onClick={handleSend} disabled={sending}>
                <Send size={14} /> {sending ? 'Sending…' : 'Send for Signing'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
