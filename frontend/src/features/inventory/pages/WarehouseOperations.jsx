// frontend/src/features/inventory/pages/WarehouseOperations.jsx
//
// The floor: put-away, unit loads, material-handling equipment and RFID.
//
// Put-away is the one that matters most. Receipt created stock in a WAREHOUSE
// and nothing ever recorded moving it to a BIN, which is why every
// `inventory_batches.bin_id` was NULL and why tracing a lot stopped at the
// building. The bin list here reads `warehouse_bins` — the master the foreign
// keys actually point at, not the older `bin_locations` behind the Warehouse
// screen's bin tab. Those two tables have not been merged; making the one with
// referential integrity selectable is what unblocks the trace.
import { useState } from 'react';
import { Forklift } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, Tabs, DataTable, useFetch,
  card, btnP, btnS, input, INK, MUT, fmt,
} from '@/features/_shared/scmKit';

export default function WarehouseOperations() {
  const toast = useToast();
  const [tab, setTab] = useState('putaway');

  const tasks  = useFetch('/warehouse/put-away');
  const bins   = useFetch('/warehouse/storage-bins');
  const loads  = useFetch('/inventory/scm/unit-loads');
  const mhe    = useFetch('/inventory/scm/mhe');
  const items  = useFetch('/inventory/items', { params: { limit: 500 } });

  const [pa, setPa] = useState({ item_id: '', quantity: '', to_bin_id: '', batch_id: '' });
  const [scan, setScan] = useState({ epc: '', location: '' });
  const [tag, setTag] = useState({ epc: '', bound_type: 'item', bound_id: '' });

  const taskRows = tasks.data?.tasks || [];
  const binRows  = bins.data || [];
  const loadRows = loads.data?.unit_loads || (Array.isArray(loads.data) ? loads.data : []);
  const mheRows  = mhe.data?.equipment || (Array.isArray(mhe.data) ? mhe.data : []);
  const itemOptions = (items.data?.items || (Array.isArray(items.data) ? items.data : [])).slice(0, 500);

  const raise = async () => {
    if (!pa.item_id || !pa.quantity) { toast?.error?.('Item and quantity are required'); return; }
    try {
      const bin = binRows.find(b => String(b.id) === String(pa.to_bin_id));
      await api.post('/warehouse/put-away', {
        item_id: Number(pa.item_id), quantity: Number(pa.quantity),
        to_bin_id: pa.to_bin_id ? Number(pa.to_bin_id) : null,
        to_warehouse_id: bin?.warehouse_id ?? null,
        batch_id: pa.batch_id ? Number(pa.batch_id) : null,
      });
      toast?.success?.('Put-away task raised');
      setPa({ item_id: '', quantity: '', to_bin_id: '', batch_id: '' });
      tasks.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const complete = async (t) => {
    try {
      await api.post(`/warehouse/put-away/${t.id}/complete`, {});
      toast?.success?.('Put away — the lot now carries its bin');
      tasks.refetch(); bins.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const assign = async (eq) => {
    const task = window.prompt(`Assign ${eq.equipment_name} to which task?`, 'put-away');
    if (task === null) return;
    try {
      await api.post(`/inventory/scm/mhe/${eq.id}/assign`, { task_type: task });
      toast?.success?.('Assigned');
      mhe.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const release = async (eq) => {
    try {
      await api.post(`/inventory/scm/mhe/${eq.id}/release`, {});
      toast?.success?.('Released');
      mhe.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const registerTag = async () => {
    if (!tag.epc) { toast?.error?.('An EPC is required'); return; }
    try {
      await api.post('/inventory/scm/rfid/tags', {
        epc: tag.epc, bound_type: tag.bound_type,
        bound_id: tag.bound_id ? Number(tag.bound_id) : null,
      });
      toast?.success?.('Tag registered');
      setTag({ epc: '', bound_type: 'item', bound_id: '' });
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const postScan = async () => {
    if (!scan.epc) { toast?.error?.('An EPC is required'); return; }
    try {
      const { data } = await api.post('/inventory/scm/rfid/scan', { epc: scan.epc, location: scan.location || null });
      toast?.success?.(data?.resolved
        ? `Resolved to ${data.bound_type} ${data.bound_ref || data.bound_id}`
        : 'Unknown tag — the scan is recorded, not dropped');
      setScan({ epc: '', location: '' });
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  return (
    <PageShell dock={
      <PageHero
        icon={Forklift}
        eyebrow="Warehouse"
        title="Warehouse Operations"
        subtitle="Put-away to a bin, unit loads, handling equipment and tag scans"
      />
    }>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Open put-aways" value={fmt(taskRows.filter(t => t.status === 'open').length)} tint="#b45309" />
        <KPI label="Bins" value={fmt(binRows.length)} hint={`${binRows.filter(b => Number(b.current_qty) > 0).length} occupied`} />
        <KPI label="Unit loads" value={fmt(loadRows.length)} />
        <KPI label="Equipment" value={fmt(mheRows.length)}
             hint={`${mheRows.filter(e => e.status === 'available').length} available`} />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'putaway', label: 'Put-away', count: taskRows.length },
        { key: 'bins',    label: 'Bins', count: binRows.length },
        { key: 'loads',   label: 'Unit loads', count: loadRows.length },
        { key: 'mhe',     label: 'Equipment', count: mheRows.length },
        { key: 'rfid',    label: 'RFID' },
      ]} />

      {tab === 'putaway' && (
        <>
          <div style={{ ...card, marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Raise a put-away</div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12, color: MUT }}>Item
                <select value={pa.item_id} onChange={e => setPa({ ...pa, item_id: e.target.value })}
                        style={{ ...input, display: 'block', marginTop: 2, minWidth: 240 }}>
                  <option value="">Select an item…</option>
                  {itemOptions.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.item_name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Quantity
                <input type="number" min={0} value={pa.quantity} onChange={e => setPa({ ...pa, quantity: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 110 }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Destination bin
                <select value={pa.to_bin_id} onChange={e => setPa({ ...pa, to_bin_id: e.target.value })}
                        style={{ ...input, display: 'block', marginTop: 2, minWidth: 220 }}>
                  <option value="">Select a bin…</option>
                  {binRows.map(b => <option key={b.id} value={b.id}>{b.warehouse_name} · {b.label || b.bin_code}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Batch id (optional)
                <input value={pa.batch_id} onChange={e => setPa({ ...pa, batch_id: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 120 }} />
              </label>
              <button style={btnP} onClick={raise}>Raise</button>
            </div>
          </div>
          <Panel loading={tasks.loading} error={tasks.error} empty={!taskRows.length}
                 emptyHint="No put-away tasks. Raise one against received stock to give a lot its bin.">
            <DataTable rows={taskRows} columns={[
              { key: 'task_no', label: 'Task' },
              { key: 'item_code', label: 'Item', render: t => (
                <div><div style={{ fontWeight: 700 }}>{t.item_code}</div>
                     <div style={{ fontSize: 11, color: MUT }}>{t.item_name}</div></div>) },
              { key: 'batch_number', label: 'Lot', render: t => t.batch_number || '—' },
              { key: 'quantity', label: 'Qty', align: 'right', render: t => fmt(t.quantity, 2) },
              { key: 'bin', label: 'To bin', render: t => [t.row_code, t.shelf_code, t.bin_code].filter(Boolean).join(' / ') || '—' },
              { key: 'status', label: 'Status', render: t => <Pill tone={t.status === 'done' ? 'ok' : 'warn'}>{t.status}</Pill> },
              { key: 'completed_at', label: 'Completed', render: t => t.completed_at ? fmtDate(t.completed_at) : '—' },
              { key: 'act', label: '', render: t => t.status === 'open'
                ? <button style={btnS} onClick={() => complete(t)}>Complete</button> : null },
            ]} />
          </Panel>
        </>
      )}

      {tab === 'bins' && (
        <Panel loading={bins.loading} error={bins.error} empty={!binRows.length}
               emptyHint="No storage bins defined.">
          <DataTable rows={binRows} columns={[
            { key: 'warehouse_name', label: 'Store' },
            { key: 'label', label: 'Bin', render: b => b.label || b.bin_code },
            { key: 'item_code', label: 'Holding', render: b => b.item_code || '—' },
            { key: 'current_qty', label: 'Qty', align: 'right', render: b => fmt(b.current_qty, 2) },
            { key: 'capacity', label: 'Capacity', align: 'right', render: b => fmt(b.capacity, 2) },
            { key: 'batch_count', label: 'Lots', align: 'right' },
            { key: 'status', label: 'Status', render: b => <Pill tone={b.status === 'active' ? 'ok' : 'mute'}>{b.status || 'active'}</Pill> },
          ]} />
        </Panel>
      )}

      {tab === 'loads' && (
        <Panel loading={loads.loading} error={loads.error} empty={!loadRows.length}
               emptyHint="No pallets built. A unit load groups packed cartons and rolls their weight up.">
          <DataTable rows={loadRows} columns={[
            { key: 'uld_no', label: 'Unit load', render: l => l.uld_no || l.unit_load_no },
            { key: 'load_type', label: 'Type', render: l => l.load_type || 'pallet' },
            { key: 'package_count', label: 'Cartons', align: 'right' },
            { key: 'gross_weight_kg', label: 'Weight (kg)', align: 'right', render: l => fmt(l.gross_weight_kg, 2) },
            { key: 'status', label: 'Status', render: l => <Pill tone="calm">{l.status || 'built'}</Pill> },
            { key: 'created_at', label: 'Built', render: l => fmtDate(l.created_at) },
          ]} />
        </Panel>
      )}

      {tab === 'mhe' && (
        <Panel loading={mhe.loading} error={mhe.error} empty={!mheRows.length}
               emptyHint="No handling equipment registered.">
          <DataTable rows={mheRows} columns={[
            { key: 'equipment_code', label: 'Code' },
            { key: 'equipment_name', label: 'Equipment' },
            { key: 'equipment_type', label: 'Type' },
            { key: 'capacity_kg', label: 'Capacity (kg)', align: 'right', render: e => fmt(e.capacity_kg) },
            { key: 'status', label: 'Status', render: e => (
              <Pill tone={e.status === 'available' ? 'ok' : e.status === 'maintenance' ? 'bad' : 'warn'}>{e.status}</Pill>) },
            { key: 'next_service_date', label: 'Next service', render: e => e.next_service_date ? fmtDate(e.next_service_date) : '—' },
            { key: 'act', label: '', render: e => (
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btnS} onClick={() => assign(e)} disabled={e.status !== 'available'}>Assign</button>
                <button style={btnS} onClick={() => release(e)} disabled={e.status === 'available'}>Release</button>
              </div>) },
          ]} />
          <div style={{ fontSize: 11, color: MUT, marginTop: 8 }}>
            Equipment under maintenance cannot be assigned — the guard is in the API, not just this button.
          </div>
        </Panel>
      )}

      {tab === 'rfid' && (
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Register a tag</div>
            <label style={{ fontSize: 12, color: MUT, display: 'block', marginBottom: 8 }}>EPC
              <input value={tag.epc} onChange={e => setTag({ ...tag, epc: e.target.value })}
                     style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
            </label>
            <label style={{ fontSize: 12, color: MUT, display: 'block', marginBottom: 8 }}>Bound to
              <select value={tag.bound_type} onChange={e => setTag({ ...tag, bound_type: e.target.value })}
                      style={{ ...input, display: 'block', marginTop: 2, width: '100%' }}>
                <option value="item">Item</option><option value="batch">Lot</option>
                <option value="serial">Serial</option><option value="unit_load">Pallet</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: MUT, display: 'block', marginBottom: 10 }}>Id
              <input value={tag.bound_id} onChange={e => setTag({ ...tag, bound_id: e.target.value })}
                     style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
            </label>
            <button style={btnP} onClick={registerTag}>Register</button>
          </div>
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Record a scan</div>
            <label style={{ fontSize: 12, color: MUT, display: 'block', marginBottom: 8 }}>EPC
              <input value={scan.epc} onChange={e => setScan({ ...scan, epc: e.target.value })}
                     style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
            </label>
            <label style={{ fontSize: 12, color: MUT, display: 'block', marginBottom: 10 }}>Location
              <input value={scan.location} onChange={e => setScan({ ...scan, location: e.target.value })}
                     style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
            </label>
            <button style={btnP} onClick={postScan}>Record scan</button>
            <div style={{ fontSize: 11, color: MUT, marginTop: 10 }}>
              This is the same endpoint a fixed reader posts to. An unrecognised tag is stored as an
              unresolved scan rather than discarded — an unknown pallet at a dock is information.
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
