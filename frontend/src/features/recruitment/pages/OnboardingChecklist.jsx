import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListChecks, RefreshCw, CheckSquare, Square, UserPlus, AlertTriangle } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { PageHero, PageShell } from '@/components/pulse-ui';

/**
 * Onboarding — recent hires and their joining checklist.
 *
 * This is HR's checklist (hr_onboarding_checklist_templates / _progress, set up
 * by HR under Employee Records), not a copy. It used to be a hard-coded list of
 * 20 items saved only in the browser, so nobody else ever saw the progress
 * (audit 2026-11-17 B7).
 *
 * Everyone with Recruitment access sees the live progress. Ticking items is
 * HR's: the API (/onboarding/progress/:id/item) accepts it from HR roles only,
 * and this page says so instead of offering a checkbox that would fail.
 */
export default function OnboardingChecklist({ setPage, embedded = false }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);

  const [hires, setHires] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [saving, setSaving] = useState(null);

  const loadHires = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/recruitment/onboarding');
      setHires(Array.isArray(res.data) ? res.data : []);
    } catch { setHires([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadHires(); }, [loadHires]);

  const loadChecklist = useCallback(async (hire) => {
    setSelected(hire);
    setChecklist(null);
    if (!hire?.employee_id) return;
    setCheckLoading(true);
    try {
      const res = await api.get(`/onboarding/progress/${hire.employee_id}`);
      setChecklist(res.data);
    } catch (e) {
      setChecklist({ error: e?.response?.data?.message || 'You cannot view this checklist.' });
    } finally { setCheckLoading(false); }
  }, []);

  const toggle = async (item) => {
    if (!canEdit || !selected?.employee_id) return;
    const key = `${item.category}::${item.item_label}`;
    setSaving(key);
    try {
      await api.patch(`/onboarding/progress/${selected.employee_id}/item`, {
        category: item.category, item_label: item.item_label, done: !item.done,
      });
      await loadChecklist(selected);
      loadHires();
    } catch (e) {
      if (e?.response?.status === 403) {
        setCanEdit(false);
        toast('Only HR can tick onboarding items. You can see the progress here.', 'error');
      } else {
        toast(e?.response?.data?.message || 'Could not update the item', 'error');
      }
    } finally { setSaving(null); }
  };

  const groups = useMemo(() => {
    const out = {};
    (checklist?.items || []).forEach(i => { (out[i.category] = out[i.category] || []).push(i); });
    return Object.entries(out);
  }, [checklist]);

  const body = (
    <>
      {embedded && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>Hires from the last 60 days and how far HR's joining checklist has got.</span>
          <button type="button" className="pulse-btn-secondary" onClick={loadHires}><RefreshCw size={14} /> Refresh</button>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 360px) 1fr', gap: 16, alignItems: 'start' }} className="onb-grid">
        <div style={{ background: '#fff', border: '1px solid #eef0f4', borderRadius: 12, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 24, color: '#9ca3af', fontSize: 13 }}>Loading…</div>
          ) : hires.length === 0 ? (
            <div style={{ padding: 24, color: '#6b7280', fontSize: 13 }}>No one has been hired in the last 60 days.</div>
          ) : hires.map(h => {
            const pct = h.onboarding_pct;
            const on = selected?.id === h.id;
            return (
              <button key={h.id} type="button" onClick={() => loadChecklist(h)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px', border: 'none', borderBottom: '1px solid #f3f4f6',
                               background: on ? '#f5f3ff' : '#fff', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{h.name}</strong>
                  <span style={{ fontSize: 12, color: h.employee_id ? '#374151' : '#b45309' }}>
                    {h.employee_id ? (pct == null ? '—' : `${pct}%`) : 'No employee record'}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  {[h.designation, h.department].filter(Boolean).join(' · ') || '—'}
                  {h.joining_date ? ` · joins ${fmtDate(h.joining_date)}` : ''}
                  {h.hired_on ? ` · hired ${fmtDate(h.hired_on)}` : ''}
                </div>
                {h.employee_id && pct != null && (
                  <div style={{ background: '#ede9fe', borderRadius: 4, height: 4, marginTop: 6 }}>
                    <div style={{ background: 'var(--color-primary, #6B3FDB)', height: '100%', width: `${pct}%`, borderRadius: 4 }} />
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ background: '#fff', border: '1px solid #eef0f4', borderRadius: 12, padding: 18, minHeight: 200 }}>
          {!selected ? (
            <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Choose a hire to see their checklist.</p>
          ) : !selected.employee_id ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <AlertTriangle size={18} color="#b45309" />
              <div>
                <p style={{ margin: '0 0 8px', fontSize: 13 }}>
                  {selected.name} is hired but has no employee record yet, so there is no checklist. Create the employee record first.
                </p>
                <button className="pulse-btn-primary" onClick={() => setPage?.('OnboardingCenter', { tab: 'create' })}>
                  <UserPlus size={14} /> Employee creation
                </button>
              </div>
            </div>
          ) : checkLoading ? (
            <p style={{ color: '#9ca3af', fontSize: 13 }}>Loading checklist…</p>
          ) : checklist?.error ? (
            <p style={{ color: '#b91c1c', fontSize: 13 }}>{checklist.error}</p>
          ) : checklist && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, fontSize: 15 }}>
                  {selected.name}
                  {selected.employee_code && <span style={{ fontWeight: 500, color: '#6b7280', fontSize: 12 }}> · {selected.employee_code}</span>}
                </h3>
                <span style={{ fontSize: 13, color: '#374151' }}>{checklist.done} of {checklist.total} done ({checklist.pct}%)</span>
              </div>
              {!canEdit && (
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>HR ticks these items. You are seeing the live progress.</p>
              )}
              {checklist.total === 0 && (
                <p style={{ fontSize: 13, color: '#6b7280' }}>HR has not set up any checklist items yet.</p>
              )}
              {groups.map(([cat, items]) => (
                <div key={cat} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{cat}</div>
                  {items.map(item => {
                    const key = `${item.category}::${item.item_label}`;
                    const Icon = item.done ? CheckSquare : Square;
                    return (
                      <button key={key} type="button" onClick={() => toggle(item)} disabled={!canEdit || saving === key}
                              style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', textAlign: 'left', padding: '6px 4px', border: 'none',
                                       background: 'none', cursor: canEdit ? 'pointer' : 'default', fontSize: 13,
                                       color: item.done ? '#6b7280' : '#111827', textDecoration: item.done ? 'line-through' : 'none' }}>
                        <Icon size={16} color={item.done ? 'var(--color-success, #16a34a)' : '#9ca3af'} />
                        <span style={{ flex: 1 }}>{item.item_label}</span>
                        {item.done && item.completed_at && <span style={{ fontSize: 11, color: '#9ca3af' }}>{fmtDate(item.completed_at)}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      <style>{`@media (max-width: 760px) { .onb-grid { grid-template-columns: 1fr !important; } }`}</style>
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={
      <PageHero
        icon={ListChecks}
        eyebrow="Recruitment"
        title="Onboarding"
        subtitle="Hires from the last 60 days and how far HR's joining checklist has got"
        actions={<button className="plh-cta plh-cta--ghost" onClick={loadHires}><RefreshCw size={14} /> Refresh</button>}
      />
    }>
      {body}
    </PageShell>
  );
}
