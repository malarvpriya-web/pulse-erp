// frontend/src/features/procurement/pages/SupplierCapacity.jsx
//
// What each supplier has said it can deliver, per item and period — and whether
// the buy plan MRP just produced actually fits inside that.
//
// The distinction this screen refuses to blur: a supplier who has DECLARED no
// capacity is not the same as a supplier with NO capacity. The coverage check
// reports "unknown" for items nobody has declared against, and unknown is never
// folded into "covered". A plan that looks 100% covered because four of five
// suppliers never answered is worse than no check at all.
import { useState } from 'react';
import { Gauge } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, Tabs, DataTable, useFetch,
  card, btnP, btnS, input, INK, MUT, fmt,
} from '@/features/_shared/scmKit';

export default function SupplierCapacity() {
  const toast = useToast();
  const [tab, setTab] = useState('check');

  const declared = useFetch('/scm/supplier-capacity');
  const check    = useFetch('/scm/supplier-capacity/check');
  const risk     = useFetch('/inventory/planning/supplier-delay-risk');
  const vendors  = useFetch('/vendors', { params: { limit: 300 } });
  const items    = useFetch('/inventory/items', { params: { limit: 500 } });

  const [form, setForm] = useState({
    vendor_id: '', item_id: '', period_start: '', period_end: '', capacity_qty: '',
  });

  const decRows   = declared.data?.capacity || (Array.isArray(declared.data) ? declared.data : []);
  const checkRows = check.data?.items || (Array.isArray(check.data) ? check.data : []);
  const vendorOpts = (vendors.data?.vendors || (Array.isArray(vendors.data) ? vendors.data : [])).slice(0, 300);
  const itemOpts   = (items.data?.items || (Array.isArray(items.data) ? items.data : [])).slice(0, 500);

  const declare = async () => {
    if (!form.vendor_id || !form.item_id || !form.capacity_qty) {
      toast?.error?.('Supplier, item and capacity are required'); return;
    }
    try {
      await api.post('/scm/supplier-capacity', {
        vendor_id: Number(form.vendor_id), item_id: Number(form.item_id),
        period_start: form.period_start || null, period_end: form.period_end || null,
        capacity_qty: Number(form.capacity_qty),
      });
      toast?.success?.('Capacity declared');
      setForm({ vendor_id: '', item_id: '', period_start: '', period_end: '', capacity_qty: '' });
      declared.refetch(); check.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const s = check.data?.summary || {};

  return (
    <PageShell dock={
      <PageHero
        icon={Gauge}
        eyebrow="Procurement"
        title="Supplier Capacity"
        subtitle="Declared supply capacity per item and period, checked against the buy plan"
      />
    }>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Declarations" value={fmt(decRows.length)} />
        <KPI label="Plan lines covered" value={s.covered != null ? fmt(s.covered) : null} tint="#15803d" />
        <KPI label="Over declared capacity" value={s.over != null ? fmt(s.over) : null} tint="#b91c1c" />
        <KPI label="Unknown" value={s.unknown != null ? fmt(s.unknown) : null} tint="#6b7280"
             hint="No declaration — never counted as covered" />
        <KPI label="Open POs at risk" value={risk.data?.summary?.open_pos_at_risk != null
               ? fmt(risk.data.summary.open_pos_at_risk) : null} tint="#b45309" />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'check',    label: 'Coverage of the buy plan', count: checkRows.length },
        { key: 'declared', label: 'Declared capacity', count: decRows.length },
        { key: 'risk',     label: 'Delay risk' },
      ]} />

      {tab === 'check' && (
        <Panel loading={check.loading} error={check.error} empty={!checkRows.length}
               emptyHint="Nothing to check — run MRP so there is a buy plan to test against declared capacity.">
          <DataTable rows={checkRows} keyOf={(r, i) => `${r.item_id}-${i}`} columns={[
            { key: 'item_code', label: 'Item', render: r => (
              <div><div style={{ fontWeight: 700 }}>{r.item_code}</div>
                   <div style={{ fontSize: 11, color: MUT }}>{r.item_name}</div></div>) },
            { key: 'vendor_name', label: 'Supplier', render: r => r.vendor_name || '—' },
            { key: 'planned_qty', label: 'Planned buy', align: 'right', render: r => fmt(r.planned_qty, 2) },
            { key: 'capacity_qty', label: 'Declared', align: 'right',
              render: r => r.capacity_qty == null ? '—' : fmt(r.capacity_qty, 2) },
            { key: 'committed_qty', label: 'Already committed', align: 'right', render: r => fmt(r.committed_qty, 2) },
            { key: 'coverage', label: 'Coverage', render: r => (
              <Pill tone={r.coverage === 'covered' ? 'ok' : r.coverage === 'over' ? 'bad' : 'mute'}>
                {r.coverage === 'unknown' ? 'not declared' : r.coverage}</Pill>) },
          ]} />
        </Panel>
      )}

      {tab === 'declared' && (
        <>
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Record a declaration</div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12, color: MUT }}>Supplier
                <select value={form.vendor_id} onChange={e => setForm({ ...form, vendor_id: e.target.value })}
                        style={{ ...input, display: 'block', marginTop: 2, minWidth: 220 }}>
                  <option value="">Select…</option>
                  {vendorOpts.map(v => <option key={v.id} value={v.id}>{v.vendor_name || v.name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Item
                <select value={form.item_id} onChange={e => setForm({ ...form, item_id: e.target.value })}
                        style={{ ...input, display: 'block', marginTop: 2, minWidth: 220 }}>
                  <option value="">Select…</option>
                  {itemOpts.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.item_name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: MUT }}>From
                <input type="date" value={form.period_start} onChange={e => setForm({ ...form, period_start: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2 }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>To
                <input type="date" value={form.period_end} onChange={e => setForm({ ...form, period_end: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2 }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Capacity
                <input type="number" min={0} value={form.capacity_qty}
                       onChange={e => setForm({ ...form, capacity_qty: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 120 }} />
              </label>
              <button style={btnP} onClick={declare}>Declare</button>
            </div>
          </div>
          <Panel loading={declared.loading} error={declared.error} empty={!decRows.length}
                 emptyHint="No supplier has declared capacity. Every coverage check will read “not declared”, which is the truthful answer.">
            <DataTable rows={decRows} columns={[
              { key: 'vendor_name', label: 'Supplier', render: r => r.vendor_name || r.vendor_id },
              { key: 'item_code', label: 'Item', render: r => r.item_code || r.item_id },
              { key: 'period_start', label: 'From', render: r => r.period_start ? fmtDate(r.period_start) : '—' },
              { key: 'period_end', label: 'To', render: r => r.period_end ? fmtDate(r.period_end) : '—' },
              { key: 'capacity_qty', label: 'Capacity', align: 'right', render: r => fmt(r.capacity_qty, 2) },
              { key: 'committed_qty', label: 'Committed', align: 'right', render: r => fmt(r.committed_qty, 2) },
              { key: 'source', label: 'Source', render: r => <Pill tone="mute">{r.source || 'declared'}</Pill> },
            ]} />
          </Panel>
        </>
      )}

      {tab === 'risk' && (
        <Panel loading={risk.loading} error={risk.error} empty={!(risk.data?.vendors || []).length}
               emptyHint="No receipt history to score lateness from.">
          <DataTable rows={risk.data?.vendors || []} keyOf={v => v.vendor_id} columns={[
            { key: 'vendor_name', label: 'Supplier' },
            { key: 'receipts', label: 'Receipts', align: 'right' },
            { key: 'late', label: 'Late', align: 'right' },
            { key: 'late_rate_pct', label: 'Late rate', align: 'right', render: v => `${fmt(v.late_rate_pct, 1)}%` },
            { key: 'avg_days_late', label: 'Avg slip', align: 'right', render: v => `${fmt(v.avg_days_late, 1)} d` },
            { key: 'confidence', label: 'Confidence', render: v => <Pill tone={v.confidence === 'high' ? 'ok' : v.confidence === 'medium' ? 'warn' : 'mute'}>{v.confidence}</Pill> },
            { key: 'risk', label: 'Risk', render: v => (
              <Pill tone={v.risk === 'high' ? 'bad' : v.risk === 'medium' ? 'warn' : v.risk === 'low' ? 'ok' : 'mute'}>
                {v.risk === 'unknown' ? 'too few receipts' : v.risk}</Pill>) },
          ]} />
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, margin: '14px 0 6px' }}>
            Open purchase orders, with the slip this history predicts
          </div>
          <DataTable rows={risk.data?.open_purchase_orders || []} keyOf={p => p.po_id}
            empty="No open purchase orders."
            columns={[
              { key: 'po_number', label: 'PO' },
              { key: 'vendor_name', label: 'Supplier' },
              { key: 'expected_delivery_date', label: 'Expected', render: p => p.expected_delivery_date ? fmtDate(p.expected_delivery_date) : '—' },
              { key: 'predicted_delivery_date', label: 'Predicted', render: p => p.predicted_delivery_date ? fmtDate(p.predicted_delivery_date) : '—' },
              { key: 'predicted_slip_days', label: 'Slip', align: 'right', render: p => p.predicted_slip_days ? `${p.predicted_slip_days} d` : '—' },
              { key: 'basis', label: 'Basis', render: p => <span style={{ fontSize: 11, color: MUT }}>{p.basis}</span> },
            ]} />
        </Panel>
      )}
    </PageShell>
  );
}
