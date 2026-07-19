/**
 * QRCodeStudio — create & share QR codes for files, links, text and visiting
 * cards. The QR encodes a public tracked URL (/api/v1/q/:token) so the file
 * itself is never sent — only the QR image is shared with customers/consultants.
 *
 * Tabs: Create · My QR Codes · All QR Codes (admin) · Analytics (admin).
 * Admin surface = super_admin / admin / hr / manager.
 *
 * Not related to QR Attendance (site clock-in QRs under Attendance menu).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { VizCard, HBarList, Donut, DonutLegend } from '@/components/charts/PulseViz';
import logoSrc from '@/assets/logo.png';
import {
  QrCode, FileUp, Link2, Type as TypeIcon, Contact, Download, Copy,
  Trash2, Power, RefreshCw, Eye, ScanLine, Users, BarChart3,
} from 'lucide-react';

const BORDER = '#e9e4ff';

const API_ROOT  = (api.defaults.baseURL || '').replace(/\/+$/, '');
const shareUrl  = token => `${API_ROOT}/q/${token}`;

const ADMIN_ROLES = ['super_admin', 'admin', 'hr', 'manager'];

const QR_TYPES = [
  { id: 'file',  label: 'File / Document', icon: FileUp,   hint: 'Manuals, certificates, brochures, JDs — customer scans and opens the file' },
  { id: 'url',   label: 'Web Link',        icon: Link2,    hint: 'Any website or portal link — scan redirects there' },
  { id: 'text',  label: 'Text Message',    icon: TypeIcon, hint: 'A note, instructions or announcement shown on scan' },
  { id: 'vcard', label: 'Visiting Card',   icon: Contact,  hint: 'Digital business card — scan offers "Add to contacts"' },
];

const RECIPIENT_TYPES = ['customer', 'consultant', 'vendor', 'partner', 'internal', 'other'];
const COLOR_PRESETS   = ['#000000', '#6B3FDB', '#1f2937', '#0f766e', '#b91c1c', '#1d4ed8'];

const TYPE_BADGE = {
  file:  { bg: '#f5f3ff', color: '#6B3FDB', label: 'File' },
  url:   { bg: '#dbeafe', color: '#1d4ed8', label: 'Link' },
  text:  { bg: '#f0fdf4', color: '#15803d', label: 'Text' },
  vcard: { bg: '#fff7ed', color: '#c2410c', label: 'Card' },
};

/* ── QR canvas rendering (with optional centered logo) ─────────────────── */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function renderQrToCanvas(canvas, text, { fg = '#000000', bg = '#FFFFFF', withLogo = false, size = 560 } = {}) {
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: withLogo ? 'H' : 'M',
    margin: 2,
    width: size,
    color: { dark: fg, light: bg },
  });
  if (!withLogo) return;
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = logoSrc; });
  const ctx   = canvas.getContext('2d');
  const plate = canvas.width * 0.26;
  const px    = (canvas.width - plate) / 2;
  ctx.fillStyle = '#fff';
  roundRect(ctx, px, px, plate, plate, plate * 0.18);
  ctx.fill();
  const inner = plate * 0.78;
  const ratio = Math.min(inner / img.width, inner / img.height);
  const w = img.width * ratio, h = img.height * ratio;
  ctx.drawImage(img, (canvas.width - w) / 2, (canvas.width - h) / 2, w, h);
}

async function downloadQrPng(record, filenameBase) {
  const canvas = document.createElement('canvas');
  await renderQrToCanvas(canvas, shareUrl(record.share_token), {
    fg: record.fg_color || '#000000',
    bg: record.bg_color || '#FFFFFF',
    withLogo: !!record.with_logo,
    size: 900,
  });
  await new Promise(resolve => canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(filenameBase || 'qr-code').replace(/[^\w -]/g, '_')}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    resolve();
  }, 'image/png'));
}

const fmtDate = ts => ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtSize = b => b == null ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: `1px solid ${BORDER}`, fontSize: 14, boxSizing: 'border-box', outline: 'none',
};
const labelStyle = { fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 };

const EMPTY_VCARD = { name: '', designation: '', organization: '', phone: '', email: '', website: '', address: '' };

export default function QRCodeStudio() {
  const toast = useToast();
  // hasAnyRole, not role/user.role: both are the PRIMARY role of a many-to-many
  // set, so gating on them hid the All/Stats tabs (and their fetches) from anyone
  // holding manager/hr as a secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isAdmin = hasAnyRole(...ADMIN_ROLES);

  const [tab, setTab] = useState('create');

  /* ── Create form state ── */
  const [qrType, setQrType]       = useState('file');
  const [title, setTitle]         = useState('');
  const [recipient, setRecipient] = useState('');
  const [recType, setRecType]     = useState('customer');
  const [file, setFile]           = useState(null);
  const [targetUrl, setTargetUrl] = useState('');
  const [contentText, setContentText] = useState('');
  const [vcard, setVcard]         = useState(EMPTY_VCARD);
  const [fgColor, setFgColor]     = useState('#000000');
  const [withLogo, setWithLogo]   = useState(true);
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating]   = useState(false);
  const [created, setCreated]     = useState(null);   // record returned by POST

  /* ── List / analytics state ── */
  const [mine, setMine]       = useState([]);
  const [all, setAll]         = useState([]);
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null); // record pending delete
  const [scanLog, setScanLog] = useState(null);       // { record, rows }

  const previewRef = useRef(null);
  const resultRef  = useRef(null);

  /* ── Live style preview (placeholder payload until created) ── */
  useEffect(() => {
    if (tab !== 'create' || created) return;
    const canvas = previewRef.current;
    if (!canvas) return;
    renderQrToCanvas(canvas, 'https://pulse-erp/qr-style-preview', {
      fg: fgColor, bg: '#FFFFFF', withLogo, size: 300,
    }).catch(() => {});
  }, [tab, fgColor, withLogo, created]);

  /* ── Render the real QR once created ── */
  useEffect(() => {
    if (!created) return;
    const canvas = resultRef.current;
    if (!canvas) return;
    renderQrToCanvas(canvas, shareUrl(created.share_token), {
      fg: created.fg_color, bg: created.bg_color, withLogo: !!created.with_logo, size: 300,
    }).catch(() => {});
  }, [created]);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get('/qr-codes/mine'); setMine(r.data.data || []); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to load your QR codes'); }
    finally { setLoading(false); }
  }, [toast]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get('/qr-codes/all'); setAll(r.data.data || []); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to load QR codes'); }
    finally { setLoading(false); }
  }, [toast]);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get('/qr-codes/stats'); setStats(r.data.data || null); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to load analytics'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'all' && isAdmin) loadAll();
    if (tab === 'stats' && isAdmin) loadStats();
  }, [tab, isAdmin, loadMine, loadAll, loadStats]);

  /* ── Create ── */
  const resetForm = () => {
    setTitle(''); setRecipient(''); setRecType('customer'); setFile(null);
    setTargetUrl(''); setContentText(''); setVcard(EMPTY_VCARD); setExpiresAt('');
    setCreated(null);
  };

  const handleCreate = async () => {
    if (!title.trim()) return toast.error('Give this QR code a title');
    if (qrType === 'file' && !file) return toast.error('Choose a file to share');
    if (qrType === 'url' && !/^https?:\/\/.+/i.test(targetUrl)) return toast.error('Enter a valid link starting with http:// or https://');
    if (qrType === 'text' && !contentText.trim()) return toast.error('Enter the text to share');
    if (qrType === 'vcard' && !vcard.name.trim()) return toast.error('Visiting card needs at least a name');

    setCreating(true);
    try {
      const fd = new FormData();
      fd.append('title', title.trim());
      fd.append('qr_type', qrType);
      fd.append('recipient_name', recipient.trim());
      fd.append('recipient_type', recType);
      fd.append('fg_color', fgColor);
      fd.append('bg_color', '#FFFFFF');
      fd.append('with_logo', String(withLogo));
      if (expiresAt) fd.append('expires_at', new Date(expiresAt).toISOString());
      if (qrType === 'file')  fd.append('file', file);
      if (qrType === 'url')   fd.append('target_url', targetUrl.trim());
      if (qrType === 'text')  fd.append('content_text', contentText.trim());
      if (qrType === 'vcard') fd.append('vcard', JSON.stringify(vcard));

      const r = await api.post('/qr-codes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setCreated(r.data.data);
      toast.success('QR code created — download and share it');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to create QR code');
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async (token) => {
    try { await navigator.clipboard.writeText(shareUrl(token)); toast.success('Link copied'); }
    catch { toast.error('Could not copy — copy it manually'); }
  };

  const toggleActive = async (rec, refresh) => {
    try {
      await api.patch(`/qr-codes/${rec.id}/toggle`);
      toast.success(rec.is_active ? 'QR code deactivated' : 'QR code reactivated');
      refresh();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to update'); }
  };

  const doDelete = async () => {
    const rec = confirmDel;
    setConfirmDel(null);
    try {
      await api.delete(`/qr-codes/${rec.id}`);
      toast.success('QR code deleted');
      if (tab === 'all') loadAll(); else loadMine();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to delete'); }
  };

  const openScans = async (rec) => {
    try {
      const r = await api.get(`/qr-codes/${rec.id}/scans`);
      setScanLog({ record: rec, rows: r.data.data || [] });
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to load scan log'); }
  };

  const tabs = [
    { id: 'create', label: 'Create QR', icon: QrCode },
    { id: 'mine',   label: 'My QR Codes', icon: ScanLine },
    ...(isAdmin ? [
      { id: 'all',   label: 'All QR Codes', icon: Users },
      { id: 'stats', label: 'Analytics', icon: BarChart3 },
    ] : []),
  ];

  /* ── Shared table for mine/all ── */
  const renderTable = (rows, showCreator, refresh) => (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f5f3ff' }}>
            {['Title', 'Type', ...(showCreator ? ['Created By'] : []), 'Created For', 'Scans', 'Last Scanned', 'Created', 'Status', 'Actions'].map(h => (
              <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, color: '#374151', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={showCreator ? 9 : 8} style={{ padding: 36, textAlign: 'center', color: '#9ca3af' }}>
              {loading ? 'Loading…' : 'No QR codes yet. Create one from the Create QR tab.'}
            </td></tr>
          ) : rows.map(r => {
            const badge = TYPE_BADGE[r.qr_type] || TYPE_BADGE.file;
            return (
              <tr key={r.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>
                  {r.title}
                  {r.qr_type === 'file' && r.file_name && (
                    <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{r.file_name} {fmtSize(r.file_size_bytes) && `· ${fmtSize(r.file_size_bytes)}`}</div>
                  )}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: badge.bg, color: badge.color }}>{badge.label}</span>
                </td>
                {showCreator && (
                  <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>
                    {r.creator_name || '—'}
                    {r.creator_office_id && <span style={{ color: '#9ca3af', fontSize: 11 }}> · {r.creator_office_id}</span>}
                  </td>
                )}
                <td style={{ padding: '10px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                  {r.recipient_name || '—'}
                  {r.recipient_type && r.recipient_name && <span style={{ color: '#9ca3af', fontSize: 11 }}> ({r.recipient_type})</span>}
                </td>
                <td style={{ padding: '10px 14px', fontWeight: 700, color: r.scan_count > 0 ? '#15803d' : '#9ca3af' }}>{r.scan_count}</td>
                <td style={{ padding: '10px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(r.last_scanned_at)}</td>
                <td style={{ padding: '10px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{
                    padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                    background: r.is_active ? 'var(--color-success-bg, #dcfce7)' : '#fee2e2',
                    color: r.is_active ? 'var(--color-success, #15803d)' : 'var(--color-danger, #dc2626)',
                  }}>{r.is_active ? 'Active' : 'Inactive'}</span>
                </td>
                <td style={{ padding: '10px 8px', whiteSpace: 'nowrap' }}>
                  <button title="Download QR PNG" onClick={() => downloadQrPng(r, r.title)} style={iconBtn}><Download size={15} /></button>
                  <button title="Copy share link" onClick={() => copyLink(r.share_token)} style={iconBtn}><Copy size={15} /></button>
                  <button title="Scan log" onClick={() => openScans(r)} style={iconBtn}><Eye size={15} /></button>
                  <button title={r.is_active ? 'Deactivate' : 'Reactivate'} onClick={() => toggleActive(r, refresh)} style={{ ...iconBtn, color: r.is_active ? '#b45309' : '#15803d' }}><Power size={15} /></button>
                  <button title="Delete" onClick={() => setConfirmDel(r)} style={{ ...iconBtn, color: '#dc2626' }}><Trash2 size={15} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="pulse-page">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <div>
          <h2 style={{ fontWeight: 800, fontSize: 22, color: '#1f2937', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <QrCode size={22} style={{ color: '#6B3FDB' }} /> QR Code Studio
          </h2>
          <p style={{ color: '#6b7280', fontSize: 13, marginTop: 4, maxWidth: 640 }}>
            Turn files, links, text and visiting cards into shareable QR codes. Send only the QR —
            every scan is tracked. (Attendance clock-in QRs live under Attendance → QR Attendance.)
          </p>
        </div>
        {(tab === 'mine' || tab === 'all') && (
          <button className="pulse-btn-secondary" onClick={() => (tab === 'all' ? loadAll() : loadMine())}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={14} /> Refresh
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 22, borderBottom: `2px solid ${BORDER}`, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px',
              fontWeight: tab === t.id ? 700 : 500, fontSize: 14, border: 'none', background: 'none',
              cursor: 'pointer', color: tab === t.id ? '#6B3FDB' : '#6b7280',
              borderBottom: tab === t.id ? '2px solid #6B3FDB' : '2px solid transparent', marginBottom: -2,
            }}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {/* ── TAB: Create ── */}
      {tab === 'create' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 24, alignItems: 'start' }}>
          {/* Form */}
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24 }}>
            {/* Type selector */}
            <label style={labelStyle}>What should this QR code share?</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 20 }}>
              {QR_TYPES.map(t => (
                <button key={t.id} onClick={() => { setQrType(t.id); setCreated(null); }}
                  style={{
                    textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                    border: `2px solid ${qrType === t.id ? '#6B3FDB' : BORDER}`,
                    background: qrType === t.id ? '#f5f3ff' : '#fff',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13.5, color: qrType === t.id ? '#6B3FDB' : '#374151' }}>
                    <t.icon size={16} /> {t.label}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 4, lineHeight: 1.4 }}>{t.hint}</div>
                </button>
              ))}
            </div>

            {/* Common fields */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>Title *</label>
                <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. HVDC Product Manual, My Visiting Card" />
              </div>
              <div>
                <label style={labelStyle}>Created For (optional)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input style={{ ...inputStyle, flex: 1 }} value={recipient} onChange={e => setRecipient(e.target.value)}
                    placeholder="Customer / consultant name" />
                  <select style={{ ...inputStyle, width: 130 }} value={recType} onChange={e => setRecType(e.target.value)}>
                    {RECIPIENT_TYPES.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Type-specific payload */}
            {qrType === 'file' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>File to share * <span style={{ fontWeight: 400, color: '#9ca3af' }}>(PDF, image, doc — max 25 MB)</span></label>
                <input type="file" onChange={e => setFile(e.target.files?.[0] || null)}
                  style={{ ...inputStyle, padding: 8 }} />
                {file && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{file.name} · {fmtSize(file.size)}</div>}
              </div>
            )}
            {qrType === 'url' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Link *</label>
                <input style={inputStyle} value={targetUrl} onChange={e => setTargetUrl(e.target.value)}
                  placeholder="https://…" />
              </div>
            )}
            {qrType === 'text' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Text *</label>
                <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={contentText}
                  onChange={e => setContentText(e.target.value)} placeholder="The message shown when scanned…" />
              </div>
            )}
            {qrType === 'vcard' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                {[
                  ['name', 'Full Name *'], ['designation', 'Designation'], ['organization', 'Company'],
                  ['phone', 'Phone'], ['email', 'Email'], ['website', 'Website'],
                ].map(([k, lbl]) => (
                  <div key={k}>
                    <label style={labelStyle}>{lbl}</label>
                    <input style={inputStyle} value={vcard[k]} onChange={e => setVcard(v => ({ ...v, [k]: e.target.value }))} />
                  </div>
                ))}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={labelStyle}>Address</label>
                  <input style={inputStyle} value={vcard.address} onChange={e => setVcard(v => ({ ...v, address: e.target.value }))} />
                </div>
              </div>
            )}

            {/* Style options */}
            <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 16, marginTop: 4 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={labelStyle}>QR Colour</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {COLOR_PRESETS.map(c => (
                      <button key={c} onClick={() => setFgColor(c)} title={c}
                        style={{
                          width: 26, height: 26, borderRadius: 8, background: c, cursor: 'pointer',
                          border: fgColor === c ? '3px solid #a78bfa' : '2px solid #e5e7eb',
                        }} />
                    ))}
                    <input type="color" value={fgColor} onChange={e => setFgColor(e.target.value)}
                      title="Custom colour" style={{ width: 34, height: 30, border: `1px solid ${BORDER}`, borderRadius: 8, background: '#fff', cursor: 'pointer', padding: 2 }} />
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Expiry (optional)</label>
                  <input type="datetime-local" style={inputStyle} value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13.5, color: '#374151', fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={withLogo} onChange={e => setWithLogo(e.target.checked)} />
                Place our company logo in the centre
              </label>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button className="pulse-btn-primary" onClick={handleCreate} disabled={creating}
                style={{ opacity: creating ? 0.6 : 1 }}>
                {creating ? 'Generating…' : 'Generate QR Code'}
              </button>
              {created && (
                <button className="pulse-btn-secondary" onClick={resetForm}>Create Another</button>
              )}
            </div>
          </div>

          {/* Preview / result */}
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 14, padding: 20, textAlign: 'center', position: 'sticky', top: 16 }}>
            {created ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 15, color: '#15803d', marginBottom: 4 }}>✓ QR Code Ready</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>{created.title}</div>
                <canvas ref={resultRef} style={{ width: 260, height: 260, border: `1px solid ${BORDER}`, borderRadius: 12 }} />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }}>
                  <button className="pulse-btn-primary" onClick={() => downloadQrPng(created, created.title)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Download size={14} /> Download PNG
                  </button>
                  <button className="pulse-btn-secondary" onClick={() => copyLink(created.share_token)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Copy size={14} /> Copy Link
                  </button>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 12, wordBreak: 'break-all' }}>{shareUrl(created.share_token)}</div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#374151', marginBottom: 12 }}>Style Preview</div>
                <canvas ref={previewRef} style={{ width: 240, height: 240, border: `1px solid ${BORDER}`, borderRadius: 12 }} />
                <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 12 }}>
                  The final QR is generated after you click <b>Generate QR Code</b>.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── TAB: My QR Codes ── */}
      {tab === 'mine' && renderTable(mine, false, loadMine)}

      {/* ── TAB: All QR Codes (admin) ── */}
      {tab === 'all' && isAdmin && renderTable(all, true, loadAll)}

      {/* ── TAB: Analytics (admin) ── */}
      {tab === 'stats' && isAdmin && (
        <div>
          {/* KPI band */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 20 }}>
            {[
              ['Total QR Codes', stats?.totals?.total_codes],
              ['Active', stats?.totals?.active_codes],
              ['Total Scans', stats?.totals?.total_scans],
              ['Employees Creating', stats?.totals?.creators],
            ].map(([lbl, val]) => (
              <div key={lbl} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>{lbl}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#1f2937', marginTop: 4 }}>{loading ? '…' : (val ?? 0)}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            <VizCard title="QR Codes by Employee" icon={<Users size={15} />} loading={loading}
              empty={!stats?.by_creator?.length} emptyText="No QR codes created yet">
              <HBarList
                data={(stats?.by_creator || []).map(c => ({
                  name: `${c.creator_name || 'Unknown'}${c.creator_office_id ? ` (${c.creator_office_id})` : ''}`,
                  value: c.codes,
                }))}
                max={10}
              />
            </VizCard>

            <VizCard title="By Type" icon={<QrCode size={15} />} loading={loading}
              empty={!stats?.by_type?.length} emptyText="No QR codes yet">
              <Donut
                data={(stats?.by_type || []).map(t => ({ name: TYPE_BADGE[t.qr_type]?.label || t.qr_type, value: t.codes }))}
                centerLabel="Codes" centerValue={stats?.totals?.total_codes ?? 0}
              />
              <DonutLegend data={(stats?.by_type || []).map(t => ({ name: TYPE_BADGE[t.qr_type]?.label || t.qr_type, value: t.codes }))} />
            </VizCard>

            <VizCard title="Most Scanned" icon={<ScanLine size={15} />} loading={loading}
              empty={!stats?.top_scanned?.length} emptyText="No scans recorded yet">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(stats?.top_scanned || []).map(t => (
                  <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{t.creator_name || '—'} · {fmtDate(t.last_scanned_at)}</div>
                    </div>
                    <span style={{ fontWeight: 800, color: '#6B3FDB', fontSize: 15, flexShrink: 0 }}>{t.scan_count}</span>
                  </div>
                ))}
              </div>
            </VizCard>
          </div>
        </div>
      )}

      {/* Scan-log drawer (simple modal) */}
      {scanLog && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setScanLog(null); }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: 'min(620px, 92vw)', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#1f2937' }}>Scan Log — {scanLog.record.title}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>{scanLog.rows.length} scan{scanLog.rows.length === 1 ? '' : 's'} recorded</div>
              </div>
              <button className="pulse-btn-secondary" onClick={() => setScanLog(null)}>Close</button>
            </div>
            {scanLog.rows.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>Nobody has scanned this QR code yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f5f3ff' }}>
                    {['When', 'IP', 'Device'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 700, color: '#374151', borderBottom: `1px solid ${BORDER}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scanLog.rows.map(s => (
                    <tr key={s.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{fmtDate(s.scanned_at)}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280' }}>{s.ip || '—'}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 11.5 }}>{(s.user_agent || '—').slice(0, 80)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDel}
        variant="danger"
        title="Delete QR code?"
        message={confirmDel ? `"${confirmDel.title}" will stop working immediately — anyone scanning it will see an error. This cannot be undone.` : ''}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}

const iconBtn = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '5px 6px',
  color: '#6B3FDB', borderRadius: 6, verticalAlign: 'middle',
};
