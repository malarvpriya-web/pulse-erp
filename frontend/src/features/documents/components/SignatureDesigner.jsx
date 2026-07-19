/**
 * SignatureDesigner.jsx — Zoho-Sign-style field placement.
 *
 * Load the source PDF, choose a signer + field type, click on the page to drop
 * a field, then drag/resize/delete. Saves the layout to the backend and can
 * dispatch the request for signing in one step.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import PdfCanvas from './PdfCanvas';

const PURPLE = '#7c3aed';
const BORDER = '#e9e4ff';

const FIELD_TYPES = [
  { k: 'signature', l: 'Signature', w: 0.22, h: 0.06 },
  { k: 'initials',  l: 'Initials',  w: 0.10, h: 0.05 },
  { k: 'date',      l: 'Date',      w: 0.16, h: 0.035 },
  { k: 'name',      l: 'Name',      w: 0.22, h: 0.035 },
  { k: 'email',     l: 'Email',     w: 0.24, h: 0.035 },
  { k: 'text',      l: 'Text',      w: 0.22, h: 0.035 },
  { k: 'company',   l: 'Company',   w: 0.22, h: 0.035 },
  { k: 'title',     l: 'Job Title', w: 0.22, h: 0.035 },
  { k: 'checkbox',  l: 'Checkbox',  w: 0.03, h: 0.02 },
];

const SIGNER_COLORS = ['#7c3aed', '#0891b2', '#ea580c', '#16a34a', '#db2777', '#ca8a04'];

export default function SignatureDesigner({ signing, onClose, onSent, notify }) {
  const [fileData, setFileData] = useState(null);
  const [signers,  setSigners]  = useState([]);
  const [fields,   setFields]   = useState([]);
  const [activeSigner, setActiveSigner] = useState(null);
  const [activeType,   setActiveType]   = useState('signature');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const dragRef = useRef(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const [srcRes, signersRes, fieldsRes] = await Promise.all([
        api.get(`/signatures/${signing.id}/source`, { responseType: 'arraybuffer' }),
        api.get(`/signatures/${signing.id}/signers`),
        api.get(`/signatures/${signing.id}/fields`),
      ]);
      setFileData(srcRes.data);

      let sList = signersRes.data.data || [];
      // Synthesize the primary recipient as signer #1 if not yet persisted
      if (!sList.some(s => s.signing_order === 1) && signing.recipient_email) {
        sList = [{ id: null, signer_name: signing.recipient_name, signer_email: signing.recipient_email, signing_order: 1, role: 'signer', _primary: true }, ...sList];
      }
      sList.sort((a, b) => a.signing_order - b.signing_order);
      setSigners(sList);
      setActiveSigner(sList[0] || null);

      setFields((fieldsRes.data.data || []).map(f => ({ ...f, tmpId: `db-${f.id}` })));
    } catch (e) {
      setLoadErr(e?.response?.data?.error || 'Could not load the document. Upload a PDF first.');
    }
  }, [signing]);

  useEffect(() => { load(); }, [load]);

  const colorFor = (signerId) => {
    const idx = signers.findIndex(s => (s.id ?? 'primary') === (signerId ?? 'primary'));
    return SIGNER_COLORS[(idx < 0 ? 0 : idx) % SIGNER_COLORS.length];
  };

  const placeField = (page, xRatio, yRatio) => {
    if (!activeSigner) { notify?.('Add a signer first', 'error'); return; }
    const def = FIELD_TYPES.find(t => t.k === activeType);
    const nf = {
      tmpId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      id: null,
      signer_ref: activeSigner.signing_order,        // resolved to signer_id on save
      signer_id: activeSigner.id ?? null,
      field_type: activeType,
      page,
      x_ratio: Math.max(0, Math.min(xRatio - def.w / 2, 1 - def.w)),
      y_ratio: Math.max(0, Math.min(yRatio - def.h / 2, 1 - def.h)),
      w_ratio: def.w, h_ratio: def.h,
      required: true, font_size: 12,
    };
    setFields(f => [...f, nf]);
    setSelected(nf.tmpId);
  };

  const updateField = (tmpId, patch) => setFields(f => f.map(x => x.tmpId === tmpId ? { ...x, ...patch } : x));
  const removeField = (tmpId) => setFields(f => f.filter(x => x.tmpId !== tmpId));

  // Drag / resize
  const onFieldPointerDown = (e, field, mode) => {
    e.stopPropagation();
    e.preventDefault();
    setSelected(field.tmpId);
    const pageEl = e.currentTarget.closest('[data-page]');
    if (!pageEl) return;
    const rect = pageEl.getBoundingClientRect();
    dragRef.current = { tmpId: field.tmpId, mode, rect, startX: e.clientX, startY: e.clientY, orig: { ...field } };

    const move = (ev) => {
      const d = dragRef.current; if (!d) return;
      const dx = (ev.clientX - d.startX) / d.rect.width;
      const dy = (ev.clientY - d.startY) / d.rect.height;
      if (d.mode === 'move') {
        updateField(d.tmpId, {
          x_ratio: Math.max(0, Math.min(d.orig.x_ratio + dx, 1 - d.orig.w_ratio)),
          y_ratio: Math.max(0, Math.min(d.orig.y_ratio + dy, 1 - d.orig.h_ratio)),
        });
      } else {
        updateField(d.tmpId, {
          w_ratio: Math.max(0.03, Math.min(d.orig.w_ratio + dx, 1 - d.orig.x_ratio)),
          h_ratio: Math.max(0.015, Math.min(d.orig.h_ratio + dy, 1 - d.orig.y_ratio)),
        });
      }
    };
    const up = () => { dragRef.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload = fields.map(f => ({
        signer_id: f.signer_id ?? null,
        signer_ref: f.signer_ref ?? null,
        field_type: f.field_type, page: f.page,
        x_ratio: f.x_ratio, y_ratio: f.y_ratio, w_ratio: f.w_ratio, h_ratio: f.h_ratio,
        required: f.required, label: f.label || null, font_size: f.font_size || 12,
      }));
      await api.post(`/signatures/${signing.id}/fields`, { fields: payload });
      notify?.('Field layout saved');
      return true;
    } catch (e) {
      notify?.(e?.response?.data?.error || 'Failed to save fields', 'error');
      return false;
    } finally { setBusy(false); }
  };

  const saveAndSend = async () => {
    const ok = await save();
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.post(`/signatures/${signing.id}/send`);
      const anyReal = (res.data.sent || []).some(s => s.sent);
      notify?.(anyReal ? 'Invitations emailed to signers' : 'Request sent (SMTP not configured — share links manually)');
      onSent?.();
    } catch (e) {
      notify?.(e?.response?.data?.error || 'Failed to send', 'error');
    } finally { setBusy(false); }
  };

  const pageFields = (pageNum) => fields.filter(f => f.page === pageNum);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,17,26,.72)', zIndex: 9998, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{ background: '#fff', borderBottom: `1px solid ${BORDER}`, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: '#1f2937' }}>Prepare: {signing.title}</div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>Signer:</span>
          {signers.map((s) => (
            <button key={s.id ?? 'primary'} onClick={() => setActiveSigner(s)} style={{
              padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: `2px solid ${colorFor(s.id)}`,
              background: (activeSigner && (activeSigner.id ?? 'p') === (s.id ?? 'p')) ? colorFor(s.id) : '#fff',
              color: (activeSigner && (activeSigner.id ?? 'p') === (s.id ?? 'p')) ? '#fff' : colorFor(s.id),
            }}>#{s.signing_order} {s.signer_name?.split(' ')[0] || 'Signer'}</button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>Field:</span>
          {FIELD_TYPES.map(t => (
            <button key={t.k} onClick={() => setActiveType(t.k)} style={{
              padding: '5px 9px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${activeType === t.k ? PURPLE : BORDER}`,
              background: activeType === t.k ? '#f5f3ff' : '#fff',
              color: activeType === t.k ? PURPLE : '#6b7280',
            }}>{t.l}</button>
          ))}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', fontSize: 13, cursor: 'pointer' }}>Close</button>
          <button onClick={save} disabled={busy} style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${PURPLE}`, background: '#fff', color: PURPLE, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Save Layout</button>
          <button onClick={saveAndSend} disabled={busy} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: busy ? '#c4b5fd' : PURPLE, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>{busy ? 'Working…' : 'Save & Send'}</button>
        </div>
      </div>

      <div style={{ fontSize: 12, color: '#c4b5fd', textAlign: 'center', padding: '6px 0' }}>
        Click on the page to drop a <strong>{FIELD_TYPES.find(t => t.k === activeType)?.l}</strong> field for <strong>{activeSigner?.signer_name || '—'}</strong>. Drag to move · corner handle to resize · click ✕ to delete.
      </div>

      {/* Canvas area */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 0' }}>
        {loadErr ? (
          <div style={{ textAlign: 'center', color: '#fca5a5', fontSize: 14, marginTop: 40 }}>{loadErr}</div>
        ) : (
          <PdfCanvas
            fileData={fileData}
            width={780}
            onPageClick={placeField}
            renderOverlay={(pageNum) => (
              <div data-page={pageNum} style={{ position: 'absolute', inset: 0 }}>
                {pageFields(pageNum).map(f => {
                  const c = colorFor(f.signer_id);
                  const isSel = selected === f.tmpId;
                  return (
                    <div key={f.tmpId}
                      onMouseDown={e => onFieldPointerDown(e, f, 'move')}
                      style={{
                        position: 'absolute',
                        left: `${f.x_ratio * 100}%`, top: `${f.y_ratio * 100}%`,
                        width: `${f.w_ratio * 100}%`, height: `${f.h_ratio * 100}%`,
                        border: `2px ${isSel ? 'solid' : 'dashed'} ${c}`,
                        background: `${c}22`, borderRadius: 3, cursor: 'move',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, color: c, fontWeight: 700, overflow: 'hidden', userSelect: 'none',
                      }}>
                      {FIELD_TYPES.find(t => t.k === f.field_type)?.l}
                      <button onClick={e => { e.stopPropagation(); removeField(f.tmpId); }}
                        style={{ position: 'absolute', top: -9, right: -9, width: 16, height: 16, borderRadius: '50%', border: 'none', background: '#dc2626', color: '#fff', fontSize: 10, lineHeight: '16px', cursor: 'pointer', padding: 0 }}>✕</button>
                      <div onMouseDown={e => onFieldPointerDown(e, f, 'resize')}
                        style={{ position: 'absolute', bottom: -5, right: -5, width: 12, height: 12, borderRadius: 3, background: c, cursor: 'nwse-resize' }} />
                    </div>
                  );
                })}
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
