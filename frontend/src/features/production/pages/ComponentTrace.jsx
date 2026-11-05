// Component Traceability — audit finding 23.
//
// The genealogy screen could reach a component only sideways, through a
// where-used lookup that answers "which panels hold this lot". The requirement
// asks for the component's own page: supplier, PO, GRN, batch/serial, IQC,
// location history, inventory transactions, material issues, production usage,
// panels used in, assembly, QC, rework, documents, audit history.
//
// One call to /genealogy/component/:type/:id assembles the dossier, so the page
// has one loading state and one failure mode rather than fifteen.
//
// Sections that are empty say WHY they are empty. An absent section and an empty
// one look identical on a screen, and the difference is exactly what somebody
// chasing a defect needs — "no assembly record because capture began on the
// 15th" is a different fact from "this was never assembled".

import { useState, useCallback, useEffect } from 'react';
import {
  Search, Package, Truck, FileText, MapPin, ArrowLeftRight, Send,
  Wrench, CheckCircle2, Layers, ScrollText, Building2, AlertTriangle,
} from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const PURPLE = '#6B3FDB', HEAD = '#4c1d95', INK = '#374151', MUT = '#6b7280';
const card = { background: '#fff', border: '1px solid #ede9fe', borderRadius: 12, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.03)' };
const inp = { padding: '9px 14px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none' };
const btnP = { background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 };

// DATE columns arrive as 'YYYY-MM-DD' strings and timestamps as ISO. Never
// new Date('Y-M-D') for a DATE column — that parses as UTC midnight and shows
// the previous day east of UTC.
const d10 = (v) => {
  if (!v) return '—';
  const s = String(v);
  return s.length <= 10 ? s : new Date(s).toLocaleDateString();
};
const n0 = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString());

const SECTIONS = [
  { key: 'overview',              label: 'Overview',              icon: Package },
  { key: 'procurement',           label: 'Supplier · PO · GRN',   icon: Truck },
  { key: 'quality',               label: 'IQC & Quality',         icon: CheckCircle2 },
  { key: 'locationHistory',       label: 'Location History',      icon: MapPin },
  { key: 'inventoryTransactions', label: 'Inventory Transactions', icon: ArrowLeftRight },
  { key: 'materialIssues',        label: 'Material Issues',       icon: Send },
  { key: 'assembly',              label: 'Assembly',              icon: Layers },
  { key: 'panelsUsedIn',          label: 'Panels Used In',        icon: Building2 },
  { key: 'rework',                label: 'Rework',                icon: Wrench },
  { key: 'documents',             label: 'Documents',             icon: FileText },
  { key: 'auditTrail',            label: 'Audit History',         icon: ScrollText },
];

const tabBtn = (active) => ({
  padding: '9px 14px', border: 'none',
  borderBottom: active ? `3px solid ${PURPLE}` : '3px solid transparent',
  background: active ? '#f5f3ff' : 'transparent',
  color: active ? PURPLE : MUT,
  fontWeight: active ? 700 : 500, fontSize: 13, cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: 7,
  borderRadius: '8px 8px 0 0', whiteSpace: 'nowrap',
});

const th = { padding: '10px 12px', textAlign: 'left', fontSize: 11, color: MUT, fontWeight: 700, borderBottom: '2px solid #ede9fe', whiteSpace: 'nowrap' };
const td = { padding: '9px 12px', fontSize: 12.5, borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' };

function Table({ cols, rows, render }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ background: '#faf9ff' }}>{cols.map(c => <th key={c} style={th}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.id ?? i}>{render(r).map((cell, j) => <td key={j} style={td}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Empty({ note }) {
  return (
    <div style={{ padding: 22, background: '#f9fafb', borderRadius: 8, color: MUT, fontSize: 13, lineHeight: 1.55 }}>
      {note || 'Nothing recorded for this section.'}
    </div>
  );
}

export default function ComponentTrace({ initialType, initialId }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('overview');

  const load = useCallback(async (type, id) => {
    setLoading(true);
    try {
      const res = await api.get(`/genealogy/component/${type}/${id}`);
      setData(res.data);
      setResults([]);
      setTab('overview');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load component');
      setData(null);
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { if (initialType && initialId) load(initialType, initialId); }, [initialType, initialId, load]);

  const search = useCallback(async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const res = await api.get('/genealogy/search', { params: { q } });
      // Only the anchors this page can open. A production order or a project is
      // not a component, and offering them would just produce a dead click.
      const usable = (res.data || []).filter(r => ['batch', 'serial', 'item'].includes(r.type));
      setResults(usable);
      if (!usable.length) toast.info('No component, lot or serial matches that search.');
    } catch (e) { toast.error(e.response?.data?.error || 'Search failed'); }
    finally { setLoading(false); }
  }, [q, toast]);

  const a = data?.anchor;
  const s = data?.summary;
  const note = (k) => data?.notes?.[k];

  return (
    <PageShell>
      <PageHero
        // PageHero renders this itself (`<Icon size={22} />`), so it takes the
        // COMPONENT, not an element. Passing <Package /> made React try to use
        // an element as a component type and threw "Element type is invalid",
        // taking the whole page down.
        icon={Package}
        title="Component Traceability"
        subtitle="Every component, lot and serialised unit — from the supplier who shipped it to the panels it ended up in"
      />

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            id="component-trace-search"
            style={{ ...inp, flex: '1 1 320px' }}
            placeholder="Item code, manufacturer part number, batch number, supplier lot, or serial number"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
          />
          <button style={btnP} onClick={search} disabled={loading}>
            <Search size={15} /> {loading ? 'Searching…' : 'Search'}
          </button>
        </div>

        {results.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {results.map(r => (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => load(r.type, r.id)}
                style={{
                  textAlign: 'left', background: '#faf9ff', border: '1px solid #ede9fe',
                  borderRadius: 8, padding: '10px 14px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: PURPLE, background: '#ede9fe', padding: '3px 8px', borderRadius: 6 }}>{r.type}</span>
                <span style={{ fontWeight: 700, color: INK }}>{r.label}</span>
                <span style={{ color: MUT, fontSize: 12 }}>{r.sublabel}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!data && !loading && (
        <div style={{ ...card, color: MUT, fontSize: 13, textAlign: 'center', padding: 36 }}>
          <Package size={30} color={PURPLE} style={{ margin: '0 auto 12px', opacity: 0.7 }} />
          <div style={{ fontSize: 15, fontWeight: 700, color: HEAD, marginBottom: 4 }}>Search for a component</div>
          <div>A supplier's own lot number works here too — that is the reference a defect notice quotes.</div>
        </div>
      )}

      {data && (
        <>
          <div style={{ ...card, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: PURPLE, background: '#ede9fe', padding: '4px 9px', borderRadius: 6 }}>{a.type}</span>
              <span style={{ fontSize: 21, fontWeight: 800, color: HEAD }}>
                {a.batch_number || a.serial_number || a.item_code}
              </span>
              <span style={{ color: MUT, fontSize: 14 }}>{a.item_name}</span>
              {a.supplier_batch_no && (
                <span style={{ fontSize: 12, color: MUT }}>supplier lot <strong style={{ color: INK }}>{a.supplier_batch_no}</strong></span>
              )}
              {(a.manufacturer_part_no || a.item_mpn) && (
                <span style={{ fontSize: 12, color: MUT }}>MPN <strong style={{ color: INK }}>{a.manufacturer_part_no || a.item_mpn}</strong></span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 10, marginTop: 16 }}>
              {[
                ['Received', s.quantity_received], ['Available', s.quantity_available],
                ['Consumed', s.quantity_consumed], ['Rejected', s.quantity_rejected],
                ['Movements', s.movements], ['Installed', s.installations],
                ['Panels', s.panels], ['Rework', s.rework_events],
              ].map(([k, v]) => (
                <div key={k} style={{ background: '#faf9ff', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 10, color: MUT, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase' }}>{k}</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: INK, marginTop: 2 }}>{n0(v)}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 3, borderBottom: '2px solid #ede9fe', marginBottom: 16, overflowX: 'auto' }}>
            {SECTIONS.map(({ key, label, icon: Icon }) => {
              const count = key === 'overview' ? null : (data[key]?.length ?? 0);
              return (
                <button key={key} style={tabBtn(tab === key)} onClick={() => setTab(key)}>
                  <Icon size={15} /> {label}
                  {count !== null && (
                    <span style={{ fontSize: 10, fontWeight: 700, background: count ? '#ede9fe' : '#f3f4f6', color: count ? PURPLE : MUT, padding: '1px 6px', borderRadius: 8 }}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={card}>
            {tab === 'overview' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 }}>
                {[
                  ['Item code', a.item_code], ['Description', a.item_name],
                  ['Manufacturer', a.manufacturer || a.item_manufacturer],
                  ['Manufacturer part no.', a.manufacturer_part_no || a.item_mpn],
                  ['Batch number', a.batch_number], ['Supplier lot', a.supplier_batch_no],
                  ['Serial number', a.serial_number],
                  ['Manufactured', d10(a.manufacturing_date || a.manufactured_date)],
                  ['Expiry', d10(a.expiry_date)], ['Received', d10(a.received_date)],
                  ['Status', a.status], ['Quality status', a.quality_status],
                ].filter(([, v]) => v !== undefined).map(([k, v]) => (
                  <div key={k} style={{ background: '#faf9ff', borderRadius: 10, padding: '11px 13px' }}>
                    <div style={{ fontSize: 10, color: MUT, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase' }}>{k}</div>
                    <div style={{ fontSize: 13.5, color: v ? INK : MUT, fontWeight: 600, marginTop: 3 }}>{v || 'Not recorded'}</div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'procurement' && (data.procurement.length
              ? <Table cols={['Lot', 'Supplier lot', 'Supplier', 'PO', 'GRN', 'Received', 'IQC', 'Qty recd', 'Available', 'Location']}
                  rows={data.procurement}
                  render={r => [
                    <strong>{r.batch_number}</strong>, r.supplier_batch_no || '—', r.vendor_name || '—',
                    r.po_number || '—', r.grn_number || '—', d10(r.received_date),
                    <span style={{ fontWeight: 700, color: r.grn_quality_status === 'passed' ? '#166534' : r.grn_quality_status === 'failed' ? '#b91c1c' : '#92400e' }}>
                      {r.grn_quality_status || '—'}
                      {r.quality_status_source && <div style={{ fontSize: 10, fontWeight: 500, color: MUT }}>{r.quality_status_source}</div>}
                    </span>,
                    n0(r.quantity_received), n0(r.quantity_available),
                    <>{r.warehouse_name || '—'}{r.bin_code && <div style={{ fontSize: 11, color: MUT }}>bin {r.bin_code}</div>}</>,
                  ]} />
              : <Empty note={note('procurement')} />)}

            {tab === 'quality' && (data.quality.length
              ? <Table cols={['Date', 'GRN', 'Result', 'Instrument', 'Calibration cert', 'Notes']}
                  rows={data.quality}
                  render={r => [d10(r.inspection_date), r.grn_number || '—',
                    <strong style={{ color: /pass/i.test(r.overall_result) ? '#166534' : /fail/i.test(r.overall_result) ? '#b91c1c' : '#92400e' }}>{r.overall_result}</strong>,
                    r.instrument_name || '—', r.certificate_number || '—', r.notes || '—']} />
              : <Empty note={note('quality')} />)}

            {tab === 'locationHistory' && (data.locationHistory.length
              ? <Table cols={['Date', 'Movement', 'From', 'To', 'In', 'Out', 'Reference']}
                  rows={data.locationHistory}
                  render={r => [d10(r.transaction_date), r.reason_code || r.transaction_type,
                    <>{r.from_warehouse || '—'}{r.from_bin && <div style={{ fontSize: 11, color: MUT }}>bin {r.from_bin}</div>}</>,
                    <>{r.to_warehouse || '—'}{r.to_bin && <div style={{ fontSize: 11, color: MUT }}>bin {r.to_bin}</div>}</>,
                    n0(r.quantity_in), n0(r.quantity_out),
                    r.reference_type ? `${r.reference_type} ${r.reference_id ?? ''}` : '—']} />
              : <Empty note={note('locationHistory')} />)}

            {tab === 'inventoryTransactions' && (data.inventoryTransactions.length
              ? <Table cols={['Date', 'Type', 'In', 'Out', 'Balance', 'Rate', 'Work order', 'Reason']}
                  rows={data.inventoryTransactions}
                  render={r => [d10(r.transaction_date), r.transaction_type, n0(r.quantity_in), n0(r.quantity_out),
                    n0(r.balance_qty), n0(r.rate), r.production_order_id || '—', r.reason_code || r.remarks || '—']} />
              : <Empty note={note('inventoryTransactions')} />)}

            {tab === 'materialIssues' && (data.materialIssues.length
              ? <Table cols={['Issued', 'Qty', 'Work order', 'Built unit', 'Component serial', 'Issued by', 'Substitute', 'State']}
                  rows={data.materialIssues}
                  render={r => [d10(r.issued_at), n0(r.qty_issued), r.production_order_no || '—',
                    r.built_serial || <span style={{ color: MUT }}>shared</span>,
                    r.component_serial || '—', r.issued_by_name || '—',
                    r.substitute_for_item_id
                      ? <span style={{ fontSize: 11, fontWeight: 700, color: '#166534' }}>YES{r.deviation_reference ? ` · ${r.deviation_reference}` : ''}</span>
                      : '—',
                    r.reversed_at
                      ? <span style={{ color: '#92400e', fontWeight: 700, fontSize: 11 }}>REVERSED<div style={{ fontWeight: 500, color: MUT }}>{r.reversal_reason}</div></span>
                      : <span style={{ color: '#166534', fontWeight: 700, fontSize: 11 }}>LIVE</span>]} />
              : <Empty note={note('materialIssues')} />)}

            {tab === 'assembly' && (data.assembly.length
              ? <Table cols={['Panel', 'Qty', 'Fitted by', 'Station', 'Fitted at', 'Instruction', 'State']}
                  rows={data.assembly}
                  render={r => [<strong>{r.panel_serial || r.production_order_no || '—'}</strong>, n0(r.quantity),
                    r.installed_by_name || '—', r.station_code || r.work_centre_name || '—',
                    d10(r.completed_at || r.installed_at), r.work_instruction_ref || '—',
                    r.removed_at
                      ? <span style={{ color: '#92400e', fontWeight: 700, fontSize: 11 }}>REMOVED<div style={{ fontWeight: 500, color: MUT }}>{r.removal_reason}</div></span>
                      : <span style={{ color: '#166534', fontWeight: 700, fontSize: 11 }}>FITTED</span>]} />
              : <Empty note={note('assembly')} />)}

            {tab === 'panelsUsedIn' && (data.panelsUsedIn.length
              ? <Table cols={['Panel serial', 'Product', 'Work order', 'Project', 'Customer', 'Status', 'Evidence']}
                  rows={data.panelsUsedIn}
                  render={r => [<strong>{r.serial_number}</strong>, r.product_name || '—', r.production_order_no || '—',
                    r.project_code ? `${r.project_code} ${r.project_name || ''}` : '—', r.customer_name || '—', r.status,
                    r.from_assembly_record
                      ? <span style={{ fontSize: 10, fontWeight: 700, color: '#166534', background: '#dcfce7', padding: '2px 7px', borderRadius: 6 }}>ASSEMBLY RECORD</span>
                      : <span style={{ fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '2px 7px', borderRadius: 6 }}>FROM ISSUE</span>]} />
              : <Empty note={note('panelsUsedIn') || 'This component has not been consumed into any serialised unit.'} />)}

            {tab === 'rework' && (data.rework.length
              ? <Table cols={['Panel', 'Role', 'Reason', 'Defect', 'Removed by', 'Replaced by', 'Retest', 'Status']}
                  rows={data.rework}
                  render={r => [r.panel_serial || r.production_order_no || '—',
                    r.was_removed ? 'removed' : r.was_replacement ? 'replacement' : '—',
                    r.reason, r.defect_code || '—', r.removed_by_name || '—', r.replaced_by_name || '—',
                    r.retest_result || '—', r.status]} />
              : <Empty note={note('rework')} />)}

            {tab === 'documents' && (data.documents.length
              ? <Table cols={['File', 'Revision', 'Approval', 'Uploaded by', 'Uploaded']}
                  rows={data.documents}
                  render={r => [
                    r.drive_link ? <a href={r.drive_link} target="_blank" rel="noreferrer" style={{ color: PURPLE }}>{r.file_name}</a> : r.file_name,
                    r.revision_label || '—', r.approval_status || '—', r.uploaded_by_name || '—', d10(r.uploaded_at)]} />
              : <Empty note={note('documents')} />)}

            {tab === 'auditTrail' && (data.auditTrail.length
              ? <Table cols={['When', 'Action', 'Module', 'By']}
                  rows={data.auditTrail}
                  render={r => [d10(r.created_at), r.action_type, r.module_name || '—', r.user_name || '—']} />
              : <Empty note={note('auditTrail')} />)}
          </div>

          {(a.status === 'quarantine' || a.status === 'rejected' || a.quality_status === 'failed') && (
            <div style={{ ...card, marginTop: 14, borderLeft: `4px solid #b91c1c`, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <AlertTriangle size={18} color="#b91c1c" style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 13, color: INK }}>
                This lot is <strong>{a.status || a.quality_status}</strong>. It cannot be issued to production or
                fitted to a panel, and the issue and assembly paths both refuse it.
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
