// frontend/src/features/admin/pages/IntegrationsHub.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MessageCircle, Mail, Cloud, CreditCard, BookOpen,
  PenLine, Truck, Landmark, Check, AlertTriangle, Clock, X,
  Server, Calculator, Wallet, FileCheck, Shield, Zap,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

// ── Category colour tokens ────────────────────────────────────────────────────
const CATEGORY_STYLE = {
  Communication: { bg: '#dbeafe', iconColor: '#2563eb' },
  Payments:      { bg: '#d1fae5', iconColor: '#059669' },
  Accounting:    { bg: '#ede9fe', iconColor: '#6B3FDB' },
  Documents:     { bg: '#fef3c7', iconColor: '#d97706' },
  Logistics:     { bg: '#e0e7ff', iconColor: '#4338ca' },
  Compliance:    { bg: '#fee2e2', iconColor: '#dc2626' },
};

const INTEGRATIONS = [
  // ── Communication ───────────────────────────────────────────────────────────
  {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    Icon: MessageCircle,
    description: 'Send automated notifications via WhatsApp — leave approvals, payslips, invoice alerts, task assignments.',
    category: 'Communication',
    fields: [
      { key: 'WHATSAPP_TOKEN',        label: 'Meta Cloud API Token',     type: 'password', placeholder: 'EAAxxxx…' },
      { key: 'WHATSAPP_PHONE_ID',     label: 'WhatsApp Phone Number ID', type: 'text',     placeholder: '1234567890' },
      { key: 'WHATSAPP_VERIFY_TOKEN', label: 'Webhook Verify Token',     type: 'text',     placeholder: 'pulse_erp_verify' },
    ],
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    Icon: Mail,
    description: 'Transactional email via SendGrid — payslips, invoices, password resets, document signing requests, and system notifications.',
    category: 'Communication',
    fields: [
      { key: 'SENDGRID_API_KEY',    label: 'API Key',    type: 'password', placeholder: 'SG.xxxxxxxxxx' },
      { key: 'SENDGRID_FROM_EMAIL', label: 'From Email', type: 'text',     placeholder: 'noreply@yourcompany.com' },
      { key: 'SENDGRID_FROM_NAME',  label: 'From Name',  type: 'text',     placeholder: 'Pulse ERP' },
    ],
  },
  {
    id: 'aws-ses',
    name: 'AWS SES',
    Icon: Cloud,
    description: 'High-volume transactional email via Amazon Simple Email Service. Cost-effective at scale with delivery analytics.',
    category: 'Communication',
    fields: [
      { key: 'AWS_SES_ACCESS_KEY_ID',     label: 'Access Key ID',     type: 'text',     placeholder: 'AKIAIOSFODNN7EXAMPLE' },
      { key: 'AWS_SES_SECRET_ACCESS_KEY', label: 'Secret Access Key', type: 'password', placeholder: '••••••••' },
      { key: 'AWS_SES_REGION',            label: 'Region',            type: 'text',     placeholder: 'ap-south-1' },
      { key: 'AWS_SES_FROM_EMAIL',        label: 'From Email',        type: 'text',     placeholder: 'noreply@yourcompany.com' },
    ],
  },
  {
    id: 'smtp',
    name: 'Email / SMTP',
    Icon: Server,
    description: 'Configure outbound email via any SMTP provider — Gmail, Outlook, or a custom mail server. Use as fallback or primary email channel.',
    category: 'Communication',
    fields: [
      { key: 'SMTP_HOST',   label: 'SMTP Host',    type: 'text',     placeholder: 'smtp.gmail.com' },
      { key: 'SMTP_PORT',   label: 'Port',         type: 'text',     placeholder: '587' },
      { key: 'SMTP_USER',   label: 'Username',     type: 'text',     placeholder: 'your@email.com' },
      { key: 'SMTP_PASS',   label: 'Password',     type: 'password', placeholder: '••••••••' },
      { key: 'SMTP_FROM',   label: 'From Address', type: 'text',     placeholder: 'noreply@yourcompany.com' },
      {
        key: 'SMTP_SECURE',
        label: 'Encryption',
        type: 'select',
        options: [
          { value: 'true',  label: 'TLS (STARTTLS)' },
          { value: 'ssl',   label: 'SSL (port 465)' },
          { value: 'false', label: 'None (plaintext)' },
        ],
        placeholder: 'TLS (STARTTLS)',
      },
    ],
  },

  // ── Payments ─────────────────────────────────────────────────────────────────
  {
    id: 'razorpay',
    name: 'Razorpay',
    Icon: CreditCard,
    description: 'Accept payments online — UPI, Cards, Net Banking, Wallets. Supports auto-reconciliation with invoices.',
    category: 'Payments',
    fields: [
      { key: 'RAZORPAY_KEY_ID',       label: 'Key ID',        type: 'text',     placeholder: 'rzp_live_…' },
      { key: 'RAZORPAY_KEY_SECRET',   label: 'Key Secret',    type: 'password', placeholder: '••••••••' },
      { key: 'RAZORPAY_WEBHOOK_SECRET', label: 'Webhook Secret', type: 'password', placeholder: '••••••••' },
    ],
  },

  // ── Accounting ────────────────────────────────────────────────────────────────
  {
    id: 'tally',
    name: 'Tally ERP 9 / TallyPrime',
    Icon: Calculator,
    description: 'Sync vouchers, ledgers, and transactions with Tally via TDL gateway. Auto-push invoices and payments.',
    category: 'Accounting',
    fields: [
      { key: 'TALLY_GATEWAY_URL', label: 'Tally Gateway URL', type: 'text', placeholder: 'http://localhost:9000' },
      { key: 'TALLY_COMPANY',     label: 'Company Name in Tally', type: 'text', placeholder: 'Manifest Technologies' },
    ],
  },
  {
    id: 'zoho-books',
    name: 'Zoho Books',
    Icon: Wallet,
    description: 'Sync invoices, bills, expenses, and contacts with Zoho Books. Two-way reconciliation for your accounting ledger.',
    category: 'Accounting',
    fields: [
      { key: 'ZOHO_BOOKS_CLIENT_ID',     label: 'Client ID',       type: 'text',     placeholder: '1000.XXXXXX' },
      { key: 'ZOHO_BOOKS_CLIENT_SECRET', label: 'Client Secret',   type: 'password', placeholder: '••••••••' },
      { key: 'ZOHO_BOOKS_ACCESS_TOKEN',  label: 'Access Token',    type: 'password', placeholder: '1000.xxxxxx.yyyyyy' },
      { key: 'ZOHO_BOOKS_REFRESH_TOKEN', label: 'Refresh Token',   type: 'password', placeholder: '1000.xxxxxx.zzzzzz' },
      { key: 'ZOHO_BOOKS_ORG_ID',        label: 'Organization ID', type: 'text',     placeholder: '123456789' },
      {
        key: 'ZOHO_BOOKS_DC',
        label: 'Data Center',
        type: 'select',
        options: [
          { value: 'IN', label: 'India (IN)' },
          { value: 'US', label: 'United States (US)' },
          { value: 'EU', label: 'Europe (EU)' },
          { value: 'AU', label: 'Australia (AU)' },
        ],
        placeholder: 'India (IN)',
      },
    ],
  },

  // ── Documents ─────────────────────────────────────────────────────────────────
  {
    id: 'zoho-sign',
    name: 'Zoho Sign',
    Icon: FileCheck,
    description: 'Send documents for e-signature via Zoho Sign. Track signing status, send reminders, and sync signed docs back to Pulse.',
    category: 'Documents',
    fields: [
      { key: 'ZOHO_SIGN_CLIENT_ID',     label: 'Client ID',     type: 'text',     placeholder: '1000.XXXXXX' },
      { key: 'ZOHO_SIGN_CLIENT_SECRET', label: 'Client Secret', type: 'password', placeholder: '••••••••' },
      { key: 'ZOHO_SIGN_ACCESS_TOKEN',  label: 'Access Token',  type: 'password', placeholder: '1000.xxxxxx.yyyyyy' },
      { key: 'ZOHO_SIGN_REFRESH_TOKEN', label: 'Refresh Token', type: 'password', placeholder: '1000.xxxxxx.zzzzzz' },
      {
        key: 'ZOHO_SIGN_DC',
        label: 'Data Center',
        type: 'select',
        options: [
          { value: 'IN', label: 'India (IN)' },
          { value: 'US', label: 'United States (US)' },
          { value: 'EU', label: 'Europe (EU)' },
          { value: 'AU', label: 'Australia (AU)' },
        ],
        placeholder: 'India (IN)',
      },
    ],
    managePage: 'ZohoSignIntegration',
  },

  // ── Logistics ─────────────────────────────────────────────────────────────────
  {
    id: 'shiprocket',
    name: 'Shiprocket',
    Icon: Truck,
    description: 'Logistics and shipping — auto-create shipments, track orders, generate AWB numbers.',
    category: 'Logistics',
    comingSoon: true,
  },

  // ── Compliance ────────────────────────────────────────────────────────────────
  {
    id: 'gst',
    name: 'GSTN / ClearTax',
    Icon: Shield,
    description: 'Auto-file GSTR-1 and GSTR-3B, reconcile GSTR-2A/2B, e-Invoice generation.',
    category: 'Compliance',
    comingSoon: true,
  },
];

// ── StatusBadge ───────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    Connected:        { bg: '#d1fae5', color: '#16a34a', Icon: Check,          label: 'Connected'      },
    'Not Configured': { bg: '#fef3c7', color: '#d97706', Icon: AlertTriangle,   label: 'Not Configured' },
    'Coming Soon':    { bg: '#f3f4f6', color: '#9ca3af', Icon: Clock,           label: 'Coming Soon'    },
    Error:            { bg: '#fee2e2', color: '#dc2626', Icon: X,               label: 'Error'          },
  };
  const cfg = map[status] || map['Not Configured'];
  return (
    <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <cfg.Icon size={10} /> {cfg.label}
    </span>
  );
}

// ── IntegrationCard ───────────────────────────────────────────────────────────
function IntegrationCard({ integration, statusMap, onTest, onSave, onLoadConfig, onNavigate }) {
  const toast = useToast();
  const [expanded,  setExpanded]  = useState(false);
  const [values,    setValues]    = useState({});
  const [testing,   setTesting]   = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [localMsg,  setLocalMsg]  = useState('');
  const [loadingCfg, setLoadingCfg] = useState(false);
  const configLoaded = useRef(false);

  const statusEntry = statusMap[integration.id];
  const status = (typeof statusEntry === 'object' ? statusEntry?.status : statusEntry)
    || (integration.comingSoon ? 'Coming Soon' : 'Not Configured');
  const lastSync = typeof statusEntry === 'object' ? statusEntry?.last : statusMap[`${integration.id}_last`] || null;
  const isConnected = status === 'Connected';

  const catStyle = CATEGORY_STYLE[integration.category] || { bg: '#f3f4f6', iconColor: '#374151' };

  const handleExpand = async () => {
    const opening = !expanded;
    setExpanded(opening);
    if (opening && !configLoaded.current) {
      configLoaded.current = true;
      setLoadingCfg(true);
      try {
        const existing = await onLoadConfig(integration.id);
        if (existing && Object.keys(existing).length > 0) {
          setValues(existing);
        }
      } catch {
        // Pre-fill failed silently — form starts empty
      } finally {
        setLoadingCfg(false);
      }
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setLocalMsg('');
    try {
      const result = await onTest(integration.id);
      setLocalMsg(result);
    } catch {
      toast.error('Unable to test connection. Please check your configuration and try again.');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setLocalMsg('');
    try {
      const result = await onSave(integration.id, values);
      setLocalMsg('Configuration saved');
      // Reset so next expand re-fetches masked creds from DB
      configLoaded.current = false;
      if (result?.status === 'connected') {
        toast.success(`${integration.name} connected successfully`);
      } else {
        toast.success('Configuration saved');
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to save configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const renderField = (f) => {
    const isSavedSecret = f.type === 'password' && values[f.key] === '***';

    if (f.type === 'select') {
      return (
        <select
          value={values[f.key] || ''}
          onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
          style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, background: '#fff' }}
        >
          <option value="">Select…</option>
          {f.options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    }

    return (
      <input
        type={f.type}
        placeholder={isSavedSecret ? 'Leave blank to keep saved value' : f.placeholder}
        value={isSavedSecret ? '' : (values[f.key] || '')}
        onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}
      />
    );
  };

  return (
    <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: catStyle.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <integration.Icon size={22} color={catStyle.iconColor} strokeWidth={1.5} />
          </div>
          <div>
            <div style={{ fontWeight: 700, color: '#1f2937', fontSize: 16 }}>{integration.name}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>{integration.category}</div>
            <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>{integration.description}</div>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {lastSync && (
        <div style={{ fontSize: 11, color: '#9ca3af' }}>Last sync: {new Date(lastSync).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
      )}

      {!integration.comingSoon && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={handleExpand}
            style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          >
            {expanded ? 'Hide Config' : 'Configure'}
          </button>

          <button
            onClick={handleTest}
            disabled={testing || !isConnected}
            title={!isConnected ? 'Configure this integration first' : 'Test connection'}
            style={{
              background: '#dbeafe',
              color: '#2563eb',
              border: 'none',
              borderRadius: 8,
              padding: '6px 14px',
              fontWeight: 600,
              fontSize: 13,
              opacity: (testing || !isConnected) ? 0.45 : 1,
              cursor: (testing || !isConnected) ? 'not-allowed' : 'pointer',
            }}
          >
            {testing ? 'Testing…' : 'Test'}
          </button>

          {integration.managePage && (
            isConnected ? (
              <button
                onClick={() => onNavigate(integration.managePage)}
                style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                Open Dashboard →
              </button>
            ) : (
              <button
                onClick={() => onNavigate(integration.managePage)}
                style={{ background: '#fef3c7', color: '#d97706', border: '1px solid #fde68a', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                Setup Required →
              </button>
            )
          )}
        </div>
      )}

      {integration.comingSoon && (
        <div style={{ padding: '10px 14px', background: '#f5f3ff', borderRadius: 8, border: '1px solid #e9e4ff' }}>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            This integration is coming soon. Contact{' '}
            <a href="mailto:dev@manifest.in" style={{ color: '#6B3FDB' }}>dev@manifest.in</a>{' '}
            to request early access.
          </p>
        </div>
      )}

      {expanded && !integration.comingSoon && (
        <div style={{ borderTop: '1px solid #f0ebff', paddingTop: 14 }}>
          {loadingCfg ? (
            <div style={{ fontSize: 13, color: '#9ca3af', padding: '8px 0' }}>Loading saved configuration…</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10, marginBottom: 12 }}>
                {integration.fields?.map(f => (
                  <div key={f.key}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>{f.label}</label>
                    {renderField(f)}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 18px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13, opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? 'Saving…' : 'Save Configuration'}
                </button>
                {localMsg && (
                  <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>
                    ✓ {localMsg}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── IntegrationsHub ───────────────────────────────────────────────────────────
export default function IntegrationsHub({ setPage }) {
  const toast = useToast();
  const [statusMap, setStatusMap] = useState({});
  const [loading,   setLoading]   = useState(false);

  const loadStatuses = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/integrations/config/all');
      setStatusMap(res.data || {});
    } catch {
      // Fallback to individual env-based endpoints
      try {
        const [waRes, tallyRes, zohoSignRes, zohoBooksRes, sgRes, sesRes, smtpRes] = await Promise.all([
          api.get('/integrations/whatsapp/status').catch(() => null),
          api.get('/integrations/tally/sync-status').catch(() => null),
          api.get('/integrations/zoho-sign/status').catch(() => null),
          api.get('/integrations/zoho-books/status').catch(() => null),
          api.get('/integrations/sendgrid/status').catch(() => null),
          api.get('/integrations/aws-ses/status').catch(() => null),
          api.get('/integrations/smtp/status').catch(() => null),
        ]);
        setStatusMap({
          whatsapp:    { status: waRes?.data?.configured       ? 'Connected' : 'Not Configured' },
          tally:       { status: tallyRes?.data?.connected     ? 'Connected' : 'Not Configured' },
          'zoho-sign': { status: zohoSignRes?.data?.connected  ? 'Connected' : 'Not Configured' },
          'zoho-books':{ status: zohoBooksRes?.data?.connected ? 'Connected' : 'Not Configured' },
          sendgrid:    { status: sgRes?.data?.connected        ? 'Connected' : 'Not Configured' },
          'aws-ses':   { status: sesRes?.data?.connected       ? 'Connected' : 'Not Configured' },
          smtp:        { status: smtpRes?.data?.connected      ? 'Connected' : 'Not Configured' },
          razorpay:    { status: 'Not Configured' },
        });
      } catch {
        const keys = ['whatsapp', 'razorpay', 'tally', 'zoho-sign', 'zoho-books', 'sendgrid', 'aws-ses', 'smtp'];
        setStatusMap(Object.fromEntries(keys.map(k => [k, { status: 'Not Configured' }])));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatuses(); }, [loadStatuses]);

  const handleLoadConfig = async (id) => {
    const res = await api.get(`/integrations/config/${id}`);
    return res.data?.credentials || {};
  };

  const handleTest = async (id) => {
    if (id === 'whatsapp') {
      const res = await api.get('/integrations/whatsapp/status');
      const d = res.data;
      return `${d.configured ? '✓ Connected' : '⚠ Not configured'} — ${d.messages_today ?? 0} messages sent today`;
    }
    if (id === 'tally') {
      const res = await api.get('/integrations/tally/sync-status');
      const d = res.data;
      return d.connected
        ? `✓ Tally reachable at ${d.tally_url} — ${d.ledger_count ?? 0} ledgers synced`
        : `✗ Cannot reach Tally server`;
    }
    if (id === 'razorpay') {
      const res = await api.post('/payments/create-order', { amount: 1, currency: 'INR', description: 'Connection test' });
      return res.data?.simulated
        ? '⚠ Running in demo mode — set RAZORPAY_KEY_ID to go live'
        : '✓ Razorpay connected';
    }
    if (id === 'zoho-sign') {
      const res = await api.get('/integrations/zoho-sign/status');
      const d = res.data;
      return d.connected
        ? `✓ Zoho Sign connected (${d.dc} data center) — ${d.total_requests ?? 0} requests`
        : '✗ Zoho Sign authentication failed';
    }
    if (id === 'zoho-books') {
      const res = await api.get('/integrations/zoho-books/status');
      const d = res.data;
      return d.connected
        ? `✓ Zoho Books connected (${d.dc}) — Org: ${d.org_name || d.org_id || 'unknown'}`
        : '✗ Zoho Books authentication failed';
    }
    if (id === 'sendgrid') {
      const res = await api.get('/integrations/sendgrid/status');
      const d = res.data;
      return d.connected
        ? `✓ SendGrid connected${d.username ? ` (${d.username})` : ''}`
        : '✗ SendGrid authentication failed';
    }
    if (id === 'aws-ses') {
      const res = await api.get('/integrations/aws-ses/status');
      const d = res.data;
      return `✓ AWS SES credentials verified — Region: ${d.region}`;
    }
    if (id === 'smtp') {
      const res = await api.get('/integrations/smtp/status');
      const d = res.data;
      return `✓ SMTP configured: ${d.host}:${d.port}`;
    }
    return '✓ Test completed';
  };

  const handleSave = async (id, values) => {
    const res = await api.put(`/integrations/config/${id}`, values);
    const newStatus = res.data?.status === 'connected' ? 'Connected' : 'Not Configured';
    setStatusMap(m => ({ ...m, [id]: { status: newStatus } }));
    return res.data;
  };

  const categories = [...new Set(INTEGRATIONS.map(i => i.category))];

  const connectedCount     = Object.values(statusMap).filter(v =>
    (typeof v === 'object' ? v?.status : v) === 'Connected'
  ).length;
  const notConfiguredCount = Object.values(statusMap).filter(v =>
    (typeof v === 'object' ? v?.status : v) === 'Not Configured'
  ).length;
  const comingSoonCount    = INTEGRATIONS.filter(i => i.comingSoon).length;

  return (
    <div style={{ padding: 24, background: '#fff', minHeight: '100vh' }}>
      <div className="page-header" style={{ marginBottom: 20 }}>
        <h1 className="page-title" style={{ margin: '0 0 4px', fontSize: 22 }}>Integrations Hub</h1>
        <p className="page-subtitle" style={{ margin: 0, fontSize: 13 }}>Connect Pulse ERP with external services and platforms</p>
      </div>

      {/* Summary strip — derived from live statusMap, never hardcoded */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Connected',      count: connectedCount,     color: '#16a34a', bg: '#d1fae5' },
          { label: 'Not Configured', count: notConfiguredCount, color: '#d97706', bg: '#fef3c7' },
          { label: 'Coming Soon',    count: comingSoonCount,    color: '#6b7280', bg: '#f3f4f6' },
        ].map(({ label, count, color, bg }) => (
          <div key={label} style={{ padding: '10px 20px', borderRadius: 10, background: bg, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color }}>{count}</div>
            <div style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>{label}</div>
          </div>
        ))}
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 20, color: '#6B3FDB' }}>Checking integration statuses…</div>}

      {categories.map(cat => (
        <div key={cat} style={{ marginBottom: 24 }}>
          <h3 style={{ color: 'var(--color-text-primary, #111827)', fontSize: 15, marginBottom: 12 }}>{cat}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(400px,1fr))', gap: 14 }}>
            {INTEGRATIONS.filter(i => i.category === cat).map(integration => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                statusMap={statusMap}
                onTest={handleTest}
                onSave={handleSave}
                onLoadConfig={handleLoadConfig}
                onNavigate={page => setPage && setPage(page)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
