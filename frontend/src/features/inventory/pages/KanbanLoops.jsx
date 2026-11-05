// frontend/src/features/inventory/pages/KanbanLoops.jsx
//
// Pull replenishment: loops, the cards circulating on them, and what happens
// when a container empties.
//
// The loop mechanics existed; the board did not. A kanban system whose cards
// can only be moved by an API call is not a pull system — the whole point is
// that the person who empties the bin raises the signal, which is a physical
// act that needs a button next to it.
import { useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, DataTable, useFetch,
  card, btnP, btnS, input, INK, MUT, fmt,
} from '@/features/_shared/scmKit';

const STATE_TONE = { full: 'ok', in_use: 'calm', empty: 'bad', signalled: 'warn', replenishing: 'warn', ordered: 'warn' };

export default function KanbanLoops() {
  const toast = useToast();
  const loops = useFetch('/inventory/scm/kanban/loops');
  const items = useFetch('/inventory/items', { params: { limit: 500 } });
  const [form, setForm] = useState({ item_id: '', card_count: 3, container_qty: 50, reorder_days: 7 });

  const rows = loops.data?.loops || (Array.isArray(loops.data) ? loops.data : []);
  const allCards = rows.flatMap(l => (l.cards || []).map(c => ({ ...c, loop_code: l.loop_code, item_code: l.item_code, item_name: l.item_name })));

  const create = async () => {
    if (!form.item_id) { toast?.error?.('Pick an item'); return; }
    try {
      await api.post('/inventory/scm/kanban/loops', {
        item_id: Number(form.item_id),
        card_count: Number(form.card_count),
        container_qty: Number(form.container_qty),
        reorder_days: Number(form.reorder_days),
      });
      toast?.success?.('Loop created with its cards');
      loops.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const signal = async (card) => {
    try {
      const { data } = await api.post(`/inventory/scm/kanban/cards/${card.id}/signal`, {});
      toast?.success?.(data?.purchase_request_id
        ? `Signal raised — purchase requisition ${data.request_number || data.purchase_request_id} created for approval`
        : 'Signal raised');
      loops.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const replenish = async (card) => {
    try {
      await api.post(`/inventory/scm/kanban/cards/${card.id}/replenish`, {});
      toast?.success?.('Container refilled — card back in circulation');
      loops.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const itemOptions = (items.data?.items || (Array.isArray(items.data) ? items.data : [])).slice(0, 500);

  return (
    <PageShell dock={
      <PageHero
        icon={RefreshCcw}
        eyebrow="Inventory"
        title="Kanban Loops"
        subtitle="Pull replenishment — an emptied container raises a requisition, and somebody approves it"
      />
    }>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Loops" value={fmt(rows.length)} />
        <KPI label="Cards circulating" value={fmt(allCards.length)} />
        <KPI label="Empty / signalled" value={fmt(allCards.filter(c => ['empty', 'signalled', 'ordered'].includes(c.state)).length)} tint="#b45309" />
        <KPI label="On the shelf" value={fmt(allCards.filter(c => c.state === 'full').length)} tint="#15803d" />
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>New loop</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12, color: MUT }}>Item
            <select value={form.item_id} onChange={e => setForm({ ...form, item_id: e.target.value })}
                    style={{ ...input, display: 'block', marginTop: 2, minWidth: 240 }}>
              <option value="">Select an item…</option>
              {itemOptions.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.item_name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12, color: MUT }}>Cards
            <input type="number" min={1} max={20} value={form.card_count}
                   onChange={e => setForm({ ...form, card_count: e.target.value })}
                   style={{ ...input, display: 'block', marginTop: 2, width: 80 }} />
          </label>
          <label style={{ fontSize: 12, color: MUT }}>Container qty
            <input type="number" min={1} value={form.container_qty}
                   onChange={e => setForm({ ...form, container_qty: e.target.value })}
                   style={{ ...input, display: 'block', marginTop: 2, width: 110 }} />
          </label>
          <label style={{ fontSize: 12, color: MUT }}>Replenish lead (days)
            <input type="number" min={1} value={form.reorder_days}
                   onChange={e => setForm({ ...form, reorder_days: e.target.value })}
                   style={{ ...input, display: 'block', marginTop: 2, width: 130 }} />
          </label>
          <button style={btnP} onClick={create}>Create loop</button>
        </div>
      </div>

      <Panel loading={loops.loading} error={loops.error} empty={!rows.length}
             emptyHint="No pull loops yet. A loop suits a steady, low-value, short-lead-time part — not everything.">
        {rows.map(loop => (
          <div key={loop.id} style={{ ...card, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 800, color: INK, fontSize: 14 }}>
                  {loop.loop_code} · {loop.item_code} {loop.item_name ? `— ${loop.item_name}` : ''}
                </div>
                <div style={{ fontSize: 11, color: MUT, marginTop: 2 }}>
                  {fmt(loop.card_count)} card(s) × {fmt(loop.container_qty)} per container
                  {loop.reorder_days ? ` · ${loop.reorder_days}-day replenishment` : ''}
                  {loop.warehouse_name ? ` · ${loop.warehouse_name}` : ''}
                </div>
              </div>
              <Pill tone={loop.status === 'active' ? 'ok' : 'mute'}>{loop.status || 'active'}</Pill>
            </div>
            <DataTable
              rows={loop.cards || []}
              empty="This loop has no cards."
              maxHeight={300}
              columns={[
                { key: 'card_no', label: 'Card', render: c => c.card_no || `#${c.id}` },
                { key: 'state', label: 'State', render: c => <Pill tone={STATE_TONE[c.state] || 'mute'}>{String(c.state || '').replace(/_/g, ' ')}</Pill> },
                { key: 'last_signal_at', label: 'Last signal', render: c => c.last_signal_at ? fmtDate(c.last_signal_at) : '—' },
                { key: 'purchase_request_id', label: 'Requisition', render: c => c.request_number || c.purchase_request_id || '—' },
                { key: 'act', label: '', render: c => (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={btnS} onClick={() => signal(c)} disabled={['signalled', 'ordered'].includes(c.state)}>
                      Empty → signal
                    </button>
                    <button style={btnS} onClick={() => replenish(c)}>Refilled</button>
                  </div>) },
              ]} />
          </div>
        ))}
      </Panel>
    </PageShell>
  );
}
