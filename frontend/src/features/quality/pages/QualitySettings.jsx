// frontend/src/features/quality/pages/QualitySettings.jsx
import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const DEFAULT_SETTINGS = {
  // IQC
  iqc_auto_ncr_on_fail: true,
  iqc_mandatory_for_grn: true,
  iqc_pass_required_before_putaway: true,
  // NCR
  ncr_auto_number_prefix: 'NCR',
  ncr_require_approval: true,
  ncr_approval_roles: 'quality_manager,admin',
  ncr_auto_capa_on_critical: true,
  ncr_close_requires_capa: true,
  // CAPA
  capa_default_due_days: 30,
  capa_require_verifier: true,
  capa_effectiveness_review_days: 90,
  // Calibration
  calibration_due_alert_days: 30,
  calibration_overdue_blocks_inspection: false,
  // Dispatch
  dispatch_requires_fat_pass: true,
  dispatch_blocks_on_open_ncr: true,
  dispatch_blocks_on_open_punch: true,
};

function Section({ title, children }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22, marginBottom: 20 }}>
      <h3 style={{ margin: '0 0 18px 0', fontSize: 14, fontWeight: 700, color: '#374151', borderBottom: '1px solid #f3f4f6', paddingBottom: 10 }}>{title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </div>
  );
}

function Toggle({ label, desc, value, onChange }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{desc}</div>}
      </div>
      <div onClick={onChange} style={{ width: 44, height: 24, borderRadius: 12, background: value ? '#6B3FDB' : '#d1d5db', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' }}>
        <div style={{ position: 'absolute', top: 2, left: value ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
      </div>
    </div>
  );
}

function TextField({ label, desc, value, onChange, type = 'text' }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{label}</label>
      {desc && <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>{desc}</div>}
      <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: 220 }} />
    </div>
  );
}

export default function QualitySettings() {
  const toast = useToast();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [original, setOriginal] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isDirty = JSON.stringify(settings) !== JSON.stringify(original);

  useEffect(() => {
    api.get('/quality/settings').then(r => {
      const data = r.data?.data || r.data;
      if (data) {
        const merged = { ...DEFAULT_SETTINGS, ...data };
        setSettings(merged);
        setOriginal(merged);
      }
    }).catch(() => toast.error('Could not load quality settings')).finally(() => setLoading(false));
  }, []);

  const set = (k, v) => setSettings(p => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/quality/settings', settings);
      setOriginal({ ...settings });
      toast.success('Quality settings saved');
    } catch (e) { toast.error(e?.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };

  const discard = () => setSettings({ ...original });

  if (loading) return <div style={{ padding: 32, color: '#6b7280' }}>Loading settings…</div>;

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Quality Settings</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isDirty && (
            <button onClick={discard} style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 18px', cursor: 'pointer', fontWeight: 500, fontSize: 13 }}>
              Discard
            </button>
          )}
          <button onClick={save} disabled={!isDirty || saving} style={{ background: !isDirty || saving ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: !isDirty || saving ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>

      <Section title="IQC — Incoming Quality Control">
        <Toggle label="Auto-create NCR on IQC Fail" desc="Automatically raise an NCR when an incoming inspection fails" value={settings.iqc_auto_ncr_on_fail} onChange={() => set('iqc_auto_ncr_on_fail', !settings.iqc_auto_ncr_on_fail)} />
        <Toggle label="IQC Mandatory for GRN" desc="Block GRN from moving to stores without IQC completion" value={settings.iqc_mandatory_for_grn} onChange={() => set('iqc_mandatory_for_grn', !settings.iqc_mandatory_for_grn)} />
        <Toggle label="IQC Pass Required Before Putaway" desc="Prevent inventory update until inspection passes" value={settings.iqc_pass_required_before_putaway} onChange={() => set('iqc_pass_required_before_putaway', !settings.iqc_pass_required_before_putaway)} />
      </Section>

      <Section title="NCR — Non-Conformance Reports">
        <TextField label="NCR Number Prefix" desc="Auto-generated NCR numbers will start with this prefix" value={settings.ncr_auto_number_prefix} onChange={v => set('ncr_auto_number_prefix', v)} />
        <Toggle label="Require NCR Approval" desc="NCRs must be approved by a quality manager before disposition" value={settings.ncr_require_approval} onChange={() => set('ncr_require_approval', !settings.ncr_require_approval)} />
        <TextField label="NCR Approval Roles" desc="Comma-separated roles that can approve NCRs" value={settings.ncr_approval_roles} onChange={v => set('ncr_approval_roles', v)} />
        <Toggle label="Auto-create CAPA on Critical NCR" desc="Critical severity NCRs automatically trigger a CAPA" value={settings.ncr_auto_capa_on_critical} onChange={() => set('ncr_auto_capa_on_critical', !settings.ncr_auto_capa_on_critical)} />
        <Toggle label="NCR Close Requires CAPA Completion" desc="All linked CAPAs must be completed/verified before NCR can close" value={settings.ncr_close_requires_capa} onChange={() => set('ncr_close_requires_capa', !settings.ncr_close_requires_capa)} />
      </Section>

      <Section title="CAPA — Corrective &amp; Preventive Action">
        <TextField label="Default CAPA Due (days)" type="number" desc="Days from creation until CAPA is due by default" value={settings.capa_default_due_days} onChange={v => set('capa_default_due_days', parseInt(v) || 30)} />
        <Toggle label="Require Verifier on CAPA" desc="A verifier must be assigned and sign off before CAPA is closed" value={settings.capa_require_verifier} onChange={() => set('capa_require_verifier', !settings.capa_require_verifier)} />
        <TextField label="Effectiveness Review (days)" type="number" desc="Days after CAPA close to review effectiveness" value={settings.capa_effectiveness_review_days} onChange={v => set('capa_effectiveness_review_days', parseInt(v) || 90)} />
      </Section>

      <Section title="Equipment Calibration">
        <TextField label="Due Alert Window (days)" type="number" desc="Trigger calibration due alerts this many days before expiry" value={settings.calibration_due_alert_days} onChange={v => set('calibration_due_alert_days', parseInt(v) || 30)} />
        <Toggle label="Overdue Calibration Blocks Inspection" desc="Prevent inspection using equipment with overdue calibration" value={settings.calibration_overdue_blocks_inspection} onChange={() => set('calibration_overdue_blocks_inspection', !settings.calibration_overdue_blocks_inspection)} />
      </Section>

      <Section title="Dispatch Gate (Production → Dispatch)">
        <Toggle label="Require FAT Pass" desc="Production orders cannot be dispatched without a passed FAT" value={settings.dispatch_requires_fat_pass} onChange={() => set('dispatch_requires_fat_pass', !settings.dispatch_requires_fat_pass)} />
        <Toggle label="Block on Open NCR" desc="Dispatch is blocked if any open NCRs exist on the production order" value={settings.dispatch_blocks_on_open_ncr} onChange={() => set('dispatch_blocks_on_open_ncr', !settings.dispatch_blocks_on_open_ncr)} />
        <Toggle label="Block on Open Punch Points" desc="Dispatch is blocked if any unresolved FAT/SAT punch points remain" value={settings.dispatch_blocks_on_open_punch} onChange={() => set('dispatch_blocks_on_open_punch', !settings.dispatch_blocks_on_open_punch)} />
      </Section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button onClick={save} disabled={saving} style={{ background: saving ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 32px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 14 }}>
          {saving ? 'Saving…' : 'Save All Settings'}
        </button>
      </div>
    </div>
  );
}
