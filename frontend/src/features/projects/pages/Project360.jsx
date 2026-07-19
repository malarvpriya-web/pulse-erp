import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import api from '@/services/api/client';

// ── Constants ─────────────────────────────────────────────────────────────────
const C = {
  primary: '#6B3FDB', light: '#f5f3ff', border: '#e9e4ff',
  green: '#16a34a', red: '#dc2626', amber: '#d97706', blue: '#2563eb',
  cyan: '#0891b2', gray: '#6b7280',
  card: { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12 },
};
const PIE_COLORS = ['#6B3FDB','#2563eb','#d97706','#16a34a','#0891b2','#dc2626','#f59e0b','#8b5cf6'];

const TABS = [
  { id: 'overview',        label: 'Overview',         icon: '📊' },
  { id: 'sales',           label: 'Sales',            icon: '💼' },
  { id: 'engineering',     label: 'Engineering',      icon: '⚙️' },
  { id: 'procurement',     label: 'Procurement',      icon: '🛒' },
  { id: 'inventory',       label: 'Inventory',        icon: '📦' },
  { id: 'manufacturing',   label: 'Manufacturing',    icon: '🏭' },
  { id: 'quality',         label: 'Quality',          icon: '🔬' },
  { id: 'logistics',       label: 'Logistics',        icon: '🚛' },
  { id: 'installation',    label: 'Installation',     icon: '🔧' },
  { id: 'commissioning',   label: 'Commissioning',    icon: '⚡' },
  { id: 'service',         label: 'Service',          icon: '🛠️' },
  { id: 'amc',             label: 'AMC',              icon: '🛡️' },
  { id: 'cost',            label: 'Cost',             icon: '💰' },
  { id: 'profitability',   label: 'Profitability',    icon: '📈' },
  { id: 'travel',          label: 'Travel',           icon: '✈️' },
  { id: 'documents',       label: 'Documents',        icon: '📁' },
  { id: 'timeline',        label: 'Timeline',         icon: '📅' },
  { id: 'risks',           label: 'Risk Engine',      icon: '⚠️' },
  { id: 'warroom',         label: 'War Room',         icon: '🚨' },
  { id: 'ai',              label: 'AI Copilot',       icon: '🤖' },
];

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtINR = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmtNum  = n => parseFloat(n || 0).toLocaleString('en-IN');
const pct     = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;

// ── Shared UI primitives ──────────────────────────────────────────────────────
function Badge({ label, color = '#374151', bg = '#f3f4f6', size = 11 }) {
  return (
    <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: size, fontWeight: 600, color, background: bg, whiteSpace: 'nowrap' }}>
      {label || '—'}
    </span>
  );
}

const STATUS_MAP = {
  active:        { color: '#15803d', bg: '#dcfce7' },
  completed:     { color: '#6b7280', bg: '#f3f4f6' },
  planning:      { color: '#1d4ed8', bg: '#dbeafe' },
  on_hold:       { color: '#92400e', bg: '#fef3c7' },
  cancelled:     { color: C.red,    bg: '#fee2e2' },
  Won:           { color: '#15803d', bg: '#dcfce7' },
  Lost:          { color: C.red,    bg: '#fee2e2' },
  Paid:          { color: '#15803d', bg: '#dcfce7' },
  Approved:      { color: '#15803d', bg: '#dcfce7' },
  Rejected:      { color: C.red,    bg: '#fee2e2' },
  Open:          { color: '#1d4ed8', bg: '#dbeafe' },
  Closed:        { color: '#6b7280', bg: '#f3f4f6' },
  passed:        { color: '#15803d', bg: '#dcfce7' },
  failed:        { color: C.red,    bg: '#fee2e2' },
  pending:       { color: C.amber,  bg: '#fef3c7' },
  'in_progress': { color: '#1d4ed8', bg: '#dbeafe' },
};
const statusBadge = s => {
  const m = STATUS_MAP[s] || { color: '#374151', bg: '#f3f4f6' };
  return <Badge label={s} {...m} />;
};

function KpiCard({ label, value, sub, color = C.primary, wide }) {
  return (
    <div style={{ ...C.card, padding: '12px 16px', minWidth: wide ? 180 : 130 }}>
      <div style={{ fontSize: 10, color: C.gray, fontWeight: 500, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.gray, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SectionCard({ title, icon, children, count, countColor = C.primary, noPad }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ ...C.card, overflow: 'hidden' }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', borderBottom: open ? `1px solid ${C.border}` : 'none', background: open ? '#fff' : '#fafafa' }}>
        {icon && <span style={{ fontSize: 16 }}>{icon}</span>}
        <span style={{ flex: 1, fontWeight: 700, fontSize: 13, color: '#111827' }}>{title}</span>
        {count !== undefined && <Badge label={count} color={countColor} bg={countColor + '22'} />}
        <span style={{ fontSize: 11, color: C.gray }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={noPad ? {} : { padding: 14 }}>{children}</div>}
    </div>
  );
}

function MiniTable({ cols, rows, empty = 'No records' }) {
  if (!rows?.length) return <p style={{ color: C.gray, fontSize: 13, textAlign: 'center', padding: '12px 0', margin: 0 }}>{empty}</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>{cols.map(c => <th key={c.key || c.label} style={{ padding: '5px 8px', textAlign: c.right ? 'right' : 'left', fontWeight: 600, color: C.gray, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
              {cols.map(c => (
                <td key={c.key || c.label} style={{ padding: '6px 8px', textAlign: c.right ? 'right' : 'left', color: '#374151' }}>
                  {c.render ? c.render(row[c.key], row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScoreBar({ label, score, color }) {
  const c = score >= 85 ? C.green : score >= 70 ? C.blue : score >= 50 ? C.amber : C.red;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: '#374151', fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: color || c }}>{score}</span>
      </div>
      <div style={{ height: 6, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color || c, borderRadius: 4, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  );
}

function EmptyTab({ msg = 'No data for this section' }) {
  return (
    <div style={{ textAlign: 'center', padding: 40, color: C.gray }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
      <div style={{ fontSize: 13 }}>{msg}</div>
    </div>
  );
}

// ── Tab: Overview ─────────────────────────────────────────────────────────────
function TabOverview({ data }) {
  const fin = data.finance || {};
  const proj = data.project || {};
  const milestones = data.milestones || [];
  const issues = data.issues || [];
  const tasks = data.tasks || [];

  const budgetData = [
    { name: 'Revenue',   value: parseFloat(fin.revenue || 0) },
    { name: 'Total Cost', value: parseFloat(fin.total_cost || 0) },
    { name: 'Profit',    value: parseFloat(fin.actual_profit || 0) },
    { name: 'Collected', value: parseFloat(fin.invoice_revenue || 0) },
  ];

  const costBreakdown = [
    { name: 'Material',     value: parseFloat(fin.material_cost || 0) },
    { name: 'Labour',       value: parseFloat(fin.labour_cost || 0) },
    { name: 'Engineering',  value: parseFloat(fin.engineering_cost || 0) },
    { name: 'Travel',       value: parseFloat(fin.travel_cost || 0) },
    { name: 'Production',   value: parseFloat(fin.production_cost || 0) },
    { name: 'Quality',      value: parseFloat(fin.quality_cost || 0) },
    { name: 'Transport',    value: parseFloat(fin.transport_cost || 0) },
    { name: 'Install+Comm', value: parseFloat(fin.installation_cost || 0) + parseFloat(fin.commissioning_cost || 0) },
    { name: 'Service',      value: parseFloat(fin.service_cost || 0) },
    { name: 'AMC',          value: parseFloat(fin.amc_cost || 0) },
  ].filter(d => d.value > 0);

  const openMiles = milestones.filter(m => m.status !== 'completed');
  const doneMiles = milestones.filter(m => m.status === 'completed');
  const openIssues = issues.filter(i => i.status !== 'Closed' && i.status !== 'closed');
  const doneTasks = tasks.filter(t => t.status === 'done').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <KpiCard label="Revenue" value={fmtINR(fin.revenue)} color={C.primary} />
        <KpiCard label="Total Cost" value={fmtINR(fin.total_cost)} color={C.blue} />
        <KpiCard label="Profit" value={fmtINR(fin.actual_profit)} color={parseFloat(fin.actual_profit||0) >= 0 ? C.green : C.red} />
        <KpiCard label="Margin" value={`${fin.margin_pct || 0}%`} color={parseFloat(fin.margin_pct||0) >= 15 ? C.green : C.amber} />
        <KpiCard label="Collected" value={fmtINR(fin.invoice_revenue)} color={C.cyan} />
        <KpiCard label="Outstanding" value={fmtINR(fin.invoice_pending)} color={C.amber} />
        <KpiCard label="Progress" value={`${proj.completion_pct || 0}%`} color={C.primary} />
        <KpiCard label="Open Issues" value={openIssues.length} color={openIssues.length > 0 ? C.red : C.green} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Budget vs Actual */}
        <SectionCard title="Budget vs Actual" icon="📊">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={budgetData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={v => fmtINR(v)} tick={{ fontSize: 9 }} />
              <Tooltip formatter={v => fmtINR(v)} />
              <Bar dataKey="value" radius={[4,4,0,0]}>
                {budgetData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        {/* Cost Breakdown Pie */}
        <SectionCard title="Cost Breakdown" icon="🍩">
          {costBreakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={costBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} label={e => e.name}>
                  {costBreakdown.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={v => fmtINR(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyTab msg="No cost data yet" />}
        </SectionCard>
      </div>

      {/* Milestone + Task summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Milestones" icon="🏁" count={milestones.length}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
            <div style={{ flex: 1, padding: '8px 12px', background: '#dcfce7', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.green }}>{doneMiles.length}</div>
              <div style={{ fontSize: 10, color: C.gray }}>Completed</div>
            </div>
            <div style={{ flex: 1, padding: '8px 12px', background: '#fef3c7', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.amber }}>{openMiles.length}</div>
              <div style={{ fontSize: 10, color: C.gray }}>Pending</div>
            </div>
          </div>
          <MiniTable
            cols={[
              { key: 'name', label: 'Milestone' },
              { key: 'due_date', label: 'Due', render: v => fmtDate(v) },
              { key: 'amount', label: '₹', right: true, render: v => fmtINR(v) },
              { key: 'status', label: '', render: v => statusBadge(v) },
            ]}
            rows={milestones.slice(0, 5)}
          />
        </SectionCard>

        <SectionCard title="Issues & Tasks" icon="⚠️">
          <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
            <div style={{ flex: 1, padding: '8px 12px', background: openIssues.length > 0 ? '#fee2e2' : '#dcfce7', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: openIssues.length > 0 ? C.red : C.green }}>{openIssues.length}</div>
              <div style={{ fontSize: 10, color: C.gray }}>Open Issues</div>
            </div>
            <div style={{ flex: 1, padding: '8px 12px', background: '#dbeafe', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.blue }}>{doneTasks}</div>
              <div style={{ fontSize: 10, color: C.gray }}>Tasks Done</div>
            </div>
            <div style={{ flex: 1, padding: '8px 12px', background: '#f5f3ff', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.primary }}>{tasks.length}</div>
              <div style={{ fontSize: 10, color: C.gray }}>Total Tasks</div>
            </div>
          </div>
          <MiniTable
            cols={[
              { key: 'title', label: 'Issue' },
              { key: 'severity', label: 'Sev', render: v => <Badge label={v} color={v==='Critical'||v==='High'?C.red:C.amber} bg={v==='Critical'||v==='High'?'#fee2e2':'#fef3c7'} /> },
              { key: 'status', label: '', render: v => statusBadge(v) },
            ]}
            rows={openIssues.slice(0, 5)}
            empty="No open issues"
          />
        </SectionCard>
      </div>
    </div>
  );
}

// ── Tab: Sales & Commercial ───────────────────────────────────────────────────
function TabSales({ data }) {
  const { opportunity, quotations = [], sales_orders = [] } = data.sales || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {opportunity && (
        <SectionCard title="CRM Opportunity" icon="🎯">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: 10 }}>
            <div style={{ padding: '8px 12px', background: C.light, borderRadius: 8 }}><div style={{ fontSize: 10, color: C.gray }}>Title</div><div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{opportunity.title || opportunity.name || '—'}</div></div>
            <div style={{ padding: '8px 12px', background: C.light, borderRadius: 8 }}><div style={{ fontSize: 10, color: C.gray }}>Value</div><div style={{ fontSize: 13, fontWeight: 700, color: C.primary }}>{fmtINR(opportunity.value)}</div></div>
            <div style={{ padding: '8px 12px', background: C.light, borderRadius: 8 }}><div style={{ fontSize: 10, color: C.gray }}>Stage</div><div style={{ marginTop: 3 }}>{statusBadge(opportunity.stage || opportunity.status)}</div></div>
          </div>
        </SectionCard>
      )}
      <SectionCard title="Quotations" icon="📋" count={quotations.length}>
        <MiniTable
          cols={[
            { key: 'quotation_number', label: 'Quote #' },
            { key: 'salesperson', label: 'Salesperson' },
            { key: 'total_amount', label: 'Amount', right: true, render: v => fmtINR(v) },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'created_at', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={quotations}
          empty="No quotations linked"
        />
      </SectionCard>
      <SectionCard title="Customer PO / Sales Orders" icon="📦" count={sales_orders.length}>
        <MiniTable
          cols={[
            { key: 'order_number', label: 'Order #' },
            { key: 'customer_name', label: 'Customer' },
            { key: 'total_amount', label: 'Value', right: true, render: v => fmtINR(v) },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'order_date', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={sales_orders}
          empty="No sales orders linked"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Engineering ─────────────────────────────────────────────────────────
function TabEngineering({ data }) {
  const { boms = [], drawings = [] } = data.engineering || {};
  const openRevisions = boms.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        <KpiCard label="BOM Revisions" value={openRevisions} color={C.primary} />
        <KpiCard label="Drawings/Docs" value={drawings.length} color={C.blue} />
        <KpiCard label="BOM Value" value={fmtINR(boms.reduce((s,b)=>s+parseFloat(b.bom_value||0),0))} color={C.green} />
      </div>
      <SectionCard title="Bill of Materials" icon="📐" count={boms.length}>
        <MiniTable
          cols={[
            { key: 'bom_number', label: 'BOM #' },
            { key: 'revision', label: 'Rev.' },
            { key: 'item_count', label: 'Items', right: true },
            { key: 'bom_value', label: 'Value', right: true, render: v => fmtINR(v) },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'created_at', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={boms}
          empty="No BOM linked to this project"
        />
      </SectionCard>
      <SectionCard title="Technical Documents & Drawings" icon="📄" count={drawings.length}>
        <MiniTable
          cols={[
            { key: 'document_name', label: 'Document' },
            { key: 'doc_type', label: 'Type' },
            { key: 'version', label: 'Ver.' },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'created_at', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={drawings}
          empty="No documents uploaded"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Procurement ──────────────────────────────────────────────────────────
function TabProcurement({ data }) {
  const { purchase_requests = [], purchase_orders = [], grns = [] } = data.procurement || {};
  const pending = purchase_orders.filter(p => ['pending','sent','draft'].includes((p.status||'').toLowerCase())).length;
  const received = grns.length;
  const totalPOValue = purchase_orders.reduce((s,p)=>s+parseFloat(p.total_amount||0),0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        <KpiCard label="Total PO Value" value={fmtINR(totalPOValue)} color={C.primary} />
        <KpiCard label="POs Pending" value={pending} color={pending > 0 ? C.amber : C.green} />
        <KpiCard label="GRNs Received" value={received} color={C.green} />
        <KpiCard label="Material Readiness" value={`${purchase_orders.length > 0 ? pct(received, purchase_orders.length) : 0}%`} color={C.cyan} />
      </div>
      <SectionCard title="Purchase Requests" icon="📝" count={purchase_requests.length}>
        <MiniTable
          cols={[
            { key: 'pr_number', label: 'PR #' },
            { key: 'total_estimated_cost', label: 'Est. Cost', right: true, render: v => fmtINR(v) },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'requested_date', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={purchase_requests}
          empty="No purchase requests"
        />
      </SectionCard>
      <SectionCard title="Purchase Orders" icon="🛒" count={purchase_orders.length}>
        <MiniTable
          cols={[
            { key: 'po_number', label: 'PO #' },
            { key: 'vendor_name', label: 'Vendor' },
            { key: 'total_amount', label: 'Amount', right: true, render: v => fmtINR(v) },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'order_date', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={purchase_orders}
          empty="No purchase orders"
        />
      </SectionCard>
      <SectionCard title="Goods Receipts (GRN)" icon="✅" count={grns.length}>
        <MiniTable
          cols={[
            { key: 'grn_number', label: 'GRN #' },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'received_date', label: 'Received', render: v => fmtDate(v) },
          ]}
          rows={grns}
          empty="No GRNs recorded"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Inventory ────────────────────────────────────────────────────────────
function TabInventory({ data }) {
  const { rm_issues = [] } = data.inventory || {};
  const totalIssued = rm_issues.reduce((s,r)=>s+parseFloat(r.quantity_issued||0),0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        <KpiCard label="RM Issues" value={rm_issues.length} color={C.primary} />
        <KpiCard label="Total Qty Issued" value={fmtNum(totalIssued)} color={C.blue} />
        <KpiCard label="Batches" value={[...new Set(rm_issues.map(r=>r.batch_number).filter(Boolean))].length} color={C.cyan} />
      </div>
      <SectionCard title="Material Issued to Project" icon="📦" count={rm_issues.length}>
        <MiniTable
          cols={[
            { key: 'item_name', label: 'Material' },
            { key: 'quantity_issued', label: 'Qty', right: true, render: v => fmtNum(v) },
            { key: 'batch_number', label: 'Batch #' },
            { key: 'issue_date', label: 'Issued On', render: v => fmtDate(v) },
          ]}
          rows={rm_issues}
          empty="No material issues recorded"
        />
      </SectionCard>
      {rm_issues.length === 0 && (
        <div style={{ padding: '20px', background: '#f9f9fb', borderRadius: 10, color: C.gray, fontSize: 13 }}>
          Inventory traceability will populate as RM issues are recorded against this project.
        </div>
      )}
    </div>
  );
}

// ── Tab: Manufacturing ────────────────────────────────────────────────────────
function TabManufacturing({ data }) {
  const { production_orders = [], timesheets = [], total_hours = 0, labour_cost = 0 } = data.manufacturing || {};
  const doneOrders = production_orders.filter(p => p.status === 'completed').length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        <KpiCard label="Production Orders" value={production_orders.length} color={C.primary} />
        <KpiCard label="Completed" value={doneOrders} color={C.green} />
        <KpiCard label="Total Hours" value={`${parseFloat(total_hours).toFixed(1)} hrs`} color={C.blue} />
        <KpiCard label="Labour Cost" value={fmtINR(labour_cost)} color={C.amber} />
      </div>
      <SectionCard title="Production Orders" icon="🏭" count={production_orders.length}>
        <MiniTable
          cols={[
            { key: 'order_number', label: 'Order #' },
            { key: 'quantity', label: 'Qty', right: true },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'planned_start', label: 'Start', render: v => fmtDate(v) },
            { key: 'planned_end', label: 'End', render: v => fmtDate(v) },
          ]}
          rows={production_orders}
          empty="No production orders"
        />
      </SectionCard>
      <SectionCard title="Engineering Timesheets" icon="⏱️" count={timesheets.length}>
        <MiniTable
          cols={[
            { key: 'employee_name', label: 'Employee' },
            { key: 'total_hours', label: 'Hours', right: true, render: v => `${parseFloat(v||0).toFixed(1)} hrs` },
            { key: 'cost', label: 'Cost', right: true, render: v => fmtINR(v) },
          ]}
          rows={timesheets}
          empty="No approved timesheets"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Quality ──────────────────────────────────────────────────────────────
function TabQuality({ data }) {
  const { ncrs = [], capas = [], inspections = [], fat_trackers = [], sat_trackers = [], ncr_open = 0, capa_open = 0, pass_rate } = data.quality || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        <KpiCard label="Total NCRs" value={ncrs.length} color={ncrs.length > 0 ? C.red : C.green} />
        <KpiCard label="Open NCRs" value={ncr_open} color={ncr_open > 0 ? C.red : C.green} />
        <KpiCard label="CAPA Open" value={capa_open} color={capa_open > 0 ? C.amber : C.green} />
        <KpiCard label="FAT Pass Rate" value={pass_rate !== null ? `${pass_rate}%` : '—'} color={pass_rate >= 80 ? C.green : C.amber} />
      </div>
      <SectionCard title="NCR Reports" icon="🔴" count={ncrs.length}>
        <MiniTable
          cols={[
            { key: 'ncr_number', label: 'NCR #' },
            { key: 'description', label: 'Description' },
            { key: 'severity', label: 'Severity', render: v => <Badge label={v} color={v==='Critical'||v==='Major'?C.red:C.amber} bg={v==='Critical'||v==='Major'?'#fee2e2':'#fef3c7'} /> },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'created_at', label: 'Raised', render: v => fmtDate(v) },
          ]}
          rows={ncrs}
          empty="No NCRs raised"
        />
      </SectionCard>
      <SectionCard title="CAPA Actions" icon="🔄" count={capas.length}>
        <MiniTable
          cols={[
            { key: 'ncr_number', label: 'NCR Ref' },
            { key: 'action_description', label: 'Action' },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'due_date', label: 'Due', render: v => fmtDate(v) },
            { key: 'completed_at', label: 'Done', render: v => fmtDate(v) },
          ]}
          rows={capas}
          empty="No CAPA actions"
        />
      </SectionCard>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <SectionCard title="Factory Acceptance Test (FAT)" icon="🔬" count={fat_trackers.length}>
          <MiniTable
            cols={[
              { key: 'fat_number', label: 'FAT #' },
              { key: 'status', label: 'Status', render: v => statusBadge(v) },
              { key: 'scheduled_date', label: 'Scheduled', render: v => fmtDate(v) },
              { key: 'completed_date', label: 'Completed', render: v => fmtDate(v) },
            ]}
            rows={fat_trackers}
            empty="No FAT records"
          />
        </SectionCard>
        <SectionCard title="Site Acceptance Test (SAT)" icon="✅" count={sat_trackers.length}>
          <MiniTable
            cols={[
              { key: 'sat_number', label: 'SAT #' },
              { key: 'status', label: 'Status', render: v => statusBadge(v) },
              { key: 'scheduled_date', label: 'Scheduled', render: v => fmtDate(v) },
              { key: 'client_signoff_date', label: 'Sign-off', render: v => fmtDate(v) },
            ]}
            rows={sat_trackers}
            empty="No SAT records"
          />
        </SectionCard>
      </div>
    </div>
  );
}

// ── Tab: Logistics ────────────────────────────────────────────────────────────
function TabLogistics({ data }) {
  const { dispatches = [] } = data.site || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        <KpiCard label="Total Shipments" value={dispatches.length} color={C.primary} />
        <KpiCard label="Delivered" value={dispatches.filter(d=>d.status==='delivered'||d.status==='Delivered').length} color={C.green} />
        <KpiCard label="In Transit" value={dispatches.filter(d=>d.status==='in_transit'||d.status==='dispatched').length} color={C.blue} />
      </div>
      <SectionCard title="Dispatch & Shipments" icon="🚛" count={dispatches.length}>
        <MiniTable
          cols={[
            { key: 'shipment_number', label: 'Shipment #' },
            { key: 'destination', label: 'Destination' },
            { key: 'tracking_number', label: 'LR / Tracking' },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'dispatch_date', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={dispatches}
          empty="No dispatch records"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Installation ─────────────────────────────────────────────────────────
function TabInstallation({ data }) {
  const lifecycle = (data.site?.lifecycle || []).filter(l => l.stage === 'installation');
  const issues = (data.issues || []).filter(i => i.status !== 'closed' && i.status !== 'Closed');
  const punchPoints = issues.filter(i => i.is_blocker);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        <KpiCard label="Installation Events" value={lifecycle.length} color={C.primary} />
        <KpiCard label="Open Issues" value={issues.length} color={issues.length > 0 ? C.amber : C.green} />
        <KpiCard label="Punch Points" value={punchPoints.length} color={punchPoints.length > 0 ? C.red : C.green} />
      </div>
      <SectionCard title="Installation Lifecycle" icon="🔧" count={lifecycle.length}>
        <MiniTable
          cols={[
            { key: 'stage', label: 'Stage', render: v => <Badge label={v} color={C.primary} bg={C.light} /> },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'started_at', label: 'Started', render: v => fmtDate(v) },
            { key: 'completed_at', label: 'Completed', render: v => fmtDate(v) },
            { key: 'notes', label: 'Notes' },
          ]}
          rows={lifecycle}
          empty="No installation records"
        />
      </SectionCard>
      <SectionCard title="Site Issues / Punch Points" icon="⚠️" count={issues.length}>
        <MiniTable
          cols={[
            { key: 'title', label: 'Issue' },
            { key: 'severity', label: 'Severity', render: v => <Badge label={v} color={v==='Critical'||v==='High'?C.red:C.amber} bg={v==='Critical'||v==='High'?'#fee2e2':'#fef3c7'} /> },
            { key: 'is_blocker', label: 'Blocker', render: v => v ? <Badge label="Yes" color={C.red} bg="#fee2e2" /> : '—' },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'created_at', label: 'Raised', render: v => fmtDate(v) },
          ]}
          rows={issues}
          empty="No open issues"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Commissioning ────────────────────────────────────────────────────────
function TabCommissioning({ data }) {
  const lifecycle = data.site?.lifecycle || [];
  const commEvents = lifecycle.filter(l => l.stage === 'commissioning' || l.stage === 'sat');
  const { sat_trackers = [], fat_trackers = [] } = data.quality || data.site || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        <KpiCard label="Commissioning Events" value={commEvents.length} color={C.primary} />
        <KpiCard label="SAT Records" value={sat_trackers.length} color={C.blue} />
        <KpiCard label="Status" value={commEvents.some(e=>e.status==='completed') ? 'Completed' : commEvents.length > 0 ? 'In Progress' : 'Not Started'} color={commEvents.some(e=>e.status==='completed') ? C.green : C.amber} />
      </div>
      <SectionCard title="Commissioning Activities" icon="⚡" count={commEvents.length}>
        <MiniTable
          cols={[
            { key: 'stage', label: 'Stage', render: v => <Badge label={v} color={C.primary} bg={C.light} /> },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'started_at', label: 'Started', render: v => fmtDate(v) },
            { key: 'completed_at', label: 'Completed', render: v => fmtDate(v) },
            { key: 'notes', label: 'Notes' },
          ]}
          rows={commEvents}
          empty="Commissioning not started"
        />
      </SectionCard>
      <SectionCard title="Site Acceptance Test (SAT)" icon="✅" count={sat_trackers.length}>
        <MiniTable
          cols={[
            { key: 'sat_number', label: 'SAT #' },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'scheduled_date', label: 'Scheduled', render: v => fmtDate(v) },
            { key: 'client_signoff_date', label: 'Client Sign-off', render: v => fmtDate(v) },
          ]}
          rows={sat_trackers}
          empty="No SAT records"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Service ──────────────────────────────────────────────────────────────
function TabService({ data }) {
  const { tickets = [], warranty = [], amc = [] } = data.service || {};
  const openTickets = tickets.filter(t => t.status !== 'closed' && t.status !== 'Closed');
  const totalServiceCost = parseFloat(data.finance?.service_cost || 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        <KpiCard label="Total Tickets" value={tickets.length} color={C.primary} />
        <KpiCard label="Open Tickets" value={openTickets.length} color={openTickets.length > 0 ? C.red : C.green} />
        <KpiCard label="Warranty" value={warranty.length} color={C.cyan} />
        <KpiCard label="Service Cost" value={fmtINR(totalServiceCost)} color={C.amber} />
      </div>
      <SectionCard title="Service Tickets" icon="🎫" count={tickets.length}>
        <MiniTable
          cols={[
            { key: 'ticket_number', label: 'Ticket #' },
            { key: 'subject', label: 'Subject' },
            { key: 'priority', label: 'Priority', render: v => <Badge label={v} color={v==='High'||v==='Critical'?C.red:C.amber} bg={v==='High'||v==='Critical'?'#fee2e2':'#fef3c7'} /> },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'created_at', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={tickets}
          empty="No service tickets"
        />
      </SectionCard>
      <SectionCard title="Warranty" icon="🛡️" count={warranty.length}>
        <MiniTable
          cols={[
            { key: 'warranty_number', label: 'Warranty #' },
            { key: 'start_date', label: 'Start', render: v => fmtDate(v) },
            { key: 'end_date', label: 'Expiry', render: v => fmtDate(v) },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
          ]}
          rows={warranty}
          empty="No warranty records"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: AMC ──────────────────────────────────────────────────────────────────
function TabAMC({ data }) {
  const { amc = [] } = data.service || {};
  const totalAMCRevenue = amc.reduce((s,a)=>s+parseFloat(a.annual_value||0),0);
  const activeAMC = amc.filter(a=>a.status==='active'||a.status==='Active').length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        <KpiCard label="Total AMC Contracts" value={amc.length} color={C.primary} />
        <KpiCard label="Active AMC" value={activeAMC} color={C.green} />
        <KpiCard label="Annual AMC Revenue" value={fmtINR(totalAMCRevenue)} color={C.cyan} />
      </div>
      <SectionCard title="AMC Contracts" icon="🛡️" count={amc.length}>
        <MiniTable
          cols={[
            { key: 'contract_number', label: 'Contract #' },
            { key: 'annual_value', label: 'Annual Value', right: true, render: v => fmtINR(v) },
            { key: 'start_date', label: 'Start', render: v => fmtDate(v) },
            { key: 'end_date', label: 'End', render: v => fmtDate(v) },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
          ]}
          rows={amc}
          empty="No AMC contracts"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Cost Center ──────────────────────────────────────────────────────────
function TabCost({ data }) {
  const fin = data.finance || {};
  const categories = [
    { label: 'Sales Travel',         value: fin.travel_cost },
    { label: 'Engineering',          value: fin.engineering_cost },
    { label: 'Materials',            value: fin.material_cost },
    { label: 'Production',           value: fin.production_cost },
    { label: 'Quality',              value: fin.quality_cost },
    { label: 'Transport',            value: fin.transport_cost },
    { label: 'Installation',         value: fin.installation_cost },
    { label: 'Commissioning',        value: fin.commissioning_cost },
    { label: 'Service',              value: fin.service_cost },
    { label: 'AMC',                  value: fin.amc_cost },
    { label: 'Overhead',             value: fin.overhead },
    { label: 'Labour',               value: fin.labour_cost },
  ].filter(c => parseFloat(c.value || 0) > 0);

  const waterfallData = categories.map(c => ({ name: c.label, value: parseFloat(c.value || 0) }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        <KpiCard label="Revenue" value={fmtINR(fin.revenue)} color={C.primary} />
        <KpiCard label="Total Cost" value={fmtINR(fin.total_cost)} color={C.blue} />
        <KpiCard label="Budget Utilization" value={`${fin.revenue > 0 ? pct(fin.total_cost, fin.revenue) : 0}%`} color={pct(fin.total_cost, fin.revenue) > 90 ? C.red : C.amber} />
      </div>

      <SectionCard title="Cost Waterfall" icon="💧">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={waterfallData} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" />
            <YAxis tickFormatter={v => fmtINR(v)} tick={{ fontSize: 9 }} />
            <Tooltip formatter={v => fmtINR(v)} />
            <Bar dataKey="value" radius={[4,4,0,0]}>
              {waterfallData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </SectionCard>

      <SectionCard title="Cost Breakdown Details" icon="📋">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {categories.map((c, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: '#fafafa', borderRadius: 8 }}>
              <span style={{ fontSize: 12, color: '#374151' }}>{c.label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: PIE_COLORS[i % PIE_COLORS.length] }}>{fmtINR(c.value)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: C.light, borderRadius: 8, gridColumn: '1 / -1', border: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>Total Cost</span>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.primary }}>{fmtINR(fin.total_cost)}</span>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

// ── Tab: Profitability ────────────────────────────────────────────────────────
function TabProfitability({ data }) {
  const fin = data.finance || {};
  const revenue = parseFloat(fin.revenue || 0);
  const cost = parseFloat(fin.total_cost || 0);
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue * 100).toFixed(1) : 0;

  const plData = [
    { name: 'Revenue', value: revenue },
    { name: 'Total Cost', value: cost },
    { name: 'Gross Profit', value: Math.max(0, profit) },
  ];

  const costItems = [
    ['Material Cost',       fin.material_cost],
    ['Labour Cost',         fin.labour_cost],
    ['Engineering Cost',    fin.engineering_cost],
    ['Travel Cost',         fin.travel_cost],
    ['Production Cost',     fin.production_cost],
    ['Quality Cost',        fin.quality_cost],
    ['Logistics Cost',      fin.transport_cost],
    ['Installation Cost',   fin.installation_cost],
    ['Commissioning Cost',  fin.commissioning_cost],
    ['Service Cost',        fin.service_cost],
    ['AMC Cost',            fin.amc_cost],
    ['Overhead',            fin.overhead],
  ].filter(([, v]) => parseFloat(v || 0) > 0);

  const mColor = parseFloat(margin) >= 20 ? C.green : parseFloat(margin) >= 10 ? C.amber : C.red;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        <KpiCard label="Revenue" value={fmtINR(revenue)} color={C.primary} />
        <KpiCard label="Total Cost" value={fmtINR(cost)} color={C.blue} />
        <KpiCard label="Gross Profit" value={fmtINR(profit)} color={profit >= 0 ? C.green : C.red} />
        <KpiCard label="Margin %" value={`${margin}%`} color={mColor} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <SectionCard title="P&L Summary" icon="📈">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Revenue</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.primary }}>{fmtINR(revenue)}</span>
            </div>
            {costItems.map(([k, v], i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0 5px 12px' }}>
                <span style={{ fontSize: 12, color: C.gray }}>− {k}</span>
                <span style={{ fontSize: 12, color: '#374151' }}>{fmtINR(v)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: `2px solid ${C.border}`, marginTop: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Gross Profit</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: profit >= 0 ? C.green : C.red }}>{fmtINR(profit)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
              <span style={{ fontSize: 12, color: C.gray }}>Margin %</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: mColor }}>{margin}%</span>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Revenue vs Cost" icon="📊">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={plData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={v => fmtINR(v)} tick={{ fontSize: 9 }} />
              <Tooltip formatter={v => fmtINR(v)} />
              <Bar dataKey="value" radius={[4,4,0,0]}>
                <Cell fill={C.primary} />
                <Cell fill={C.blue} />
                <Cell fill={C.green} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>
    </div>
  );
}

// ── Tab: Travel ───────────────────────────────────────────────────────────────
function TabTravel({ data }) {
  const { travel = [] } = data.service || {};
  const totalBudget = travel.reduce((s,t)=>s+parseFloat(t.budget||0),0);
  const approved = travel.filter(t=>t.status==='approved'||t.status==='Approved').length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        <KpiCard label="Total Travel Requests" value={travel.length} color={C.primary} />
        <KpiCard label="Approved" value={approved} color={C.green} />
        <KpiCard label="Total Budget" value={fmtINR(totalBudget)} color={C.blue} />
        <KpiCard label="Travel Cost (actual)" value={fmtINR(data.finance?.travel_cost)} color={C.amber} />
      </div>
      <SectionCard title="Travel Requests" icon="✈️" count={travel.length}>
        <MiniTable
          cols={[
            { key: 'request_number', label: 'Request #' },
            { key: 'employee_name', label: 'Employee' },
            { key: 'travel_type', label: 'Type' },
            { key: 'destination', label: 'Destination' },
            { key: 'from_date', label: 'From', render: v => fmtDate(v) },
            { key: 'to_date', label: 'To', render: v => fmtDate(v) },
            { key: 'budget', label: 'Budget', right: true, render: v => fmtINR(v) },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
          ]}
          rows={travel}
          empty="No travel requests"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Documents ────────────────────────────────────────────────────────────
function TabDocuments({ data }) {
  const drawings = data.engineering?.drawings || [];
  const folders = [
    'Contract', 'Drawings', 'BOM', 'Procurement', 'FAT', 'SAT',
    'Commissioning', 'Service', 'AMC', 'Financial',
  ];
  const projNum = data.project?.project_number || '—';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionCard title="Document Center" icon="📁">
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.gray, marginBottom: 8 }}>GOOGLE DRIVE FOLDER STRUCTURE</div>
          <div style={{ padding: '12px 14px', background: '#fafafa', borderRadius: 8, fontFamily: 'monospace', fontSize: 12, color: '#374151', lineHeight: 2 }}>
            <div>📂 Projects</div>
            <div style={{ paddingLeft: 20 }}>📂 {projNum}</div>
            {folders.map(f => (
              <div key={f} style={{ paddingLeft: 40 }}>📄 {f}</div>
            ))}
          </div>
        </div>
      </SectionCard>
      <SectionCard title="Uploaded Documents" icon="📄" count={drawings.length}>
        <MiniTable
          cols={[
            { key: 'document_name', label: 'Document' },
            { key: 'doc_type', label: 'Type' },
            { key: 'version', label: 'Ver.' },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'created_at', label: 'Date', render: v => fmtDate(v) },
          ]}
          rows={drawings}
          empty="No documents uploaded"
        />
      </SectionCard>
    </div>
  );
}

// ── Tab: Timeline ─────────────────────────────────────────────────────────────
function TabTimeline({ data }) {
  const events = data.timeline || [];
  if (!events.length) return <EmptyTab msg="No timeline events. Add milestones and lifecycle data to populate the timeline." />;
  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ position: 'relative', paddingLeft: 32 }}>
        <div style={{ position: 'absolute', left: 15, top: 0, bottom: 0, width: 2, background: C.border }} />
        {events.map((evt, i) => (
          <div key={i} style={{ position: 'relative', marginBottom: 20 }}>
            <div style={{
              position: 'absolute', left: -24, top: 2, width: 18, height: 18, borderRadius: '50%',
              background: evt.color || C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, border: '2px solid #fff', boxShadow: '0 0 0 2px ' + (evt.color || C.primary) + '44',
            }}>
              {evt.icon || '•'}
            </div>
            <div style={{ ...C.card, padding: '10px 14px', marginLeft: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{evt.label}</span>
                <span style={{ fontSize: 11, color: C.gray, whiteSpace: 'nowrap', marginLeft: 12 }}>{evt.display}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab: Risk Engine ──────────────────────────────────────────────────────────
function TabRisks({ data }) {
  const risks = data.risks || [];
  const levelColor = l => l === 'Critical' ? C.red : l === 'High' ? '#ea580c' : l === 'Medium' ? C.amber : C.green;
  const levelBg    = l => l === 'Critical' ? '#fee2e2' : l === 'High' ? '#ffedd5' : l === 'Medium' ? '#fef3c7' : '#dcfce7';
  const byLevel = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  risks.forEach(r => { if (byLevel[r.level] !== undefined) byLevel[r.level]++; });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        {Object.entries(byLevel).map(([level, count]) => (
          <div key={level} style={{ ...C.card, padding: '12px 16px', borderLeft: `4px solid ${levelColor(level)}` }}>
            <div style={{ fontSize: 10, color: C.gray, marginBottom: 2 }}>{level}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: levelColor(level) }}>{count}</div>
          </div>
        ))}
      </div>
      <SectionCard title="Risk Register" icon="⚠️" count={risks.length}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {risks.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: levelBg(r.level), borderRadius: 8, borderLeft: `4px solid ${levelColor(r.level)}` }}>
              <Badge label={r.level} color={levelColor(r.level)} bg={levelBg(r.level)} />
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginRight: 8, textTransform: 'uppercase' }}>{r.category}</span>
                <span style={{ fontSize: 13, color: '#111827' }}>{r.description}</span>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

// ── Tab: War Room ─────────────────────────────────────────────────────────────
function TabWarRoom({ data }) {
  const alerts = data.alerts || [];
  const levelColor = l => l === 'critical' ? C.red : l === 'high' ? '#ea580c' : C.amber;
  const levelBg = l => l === 'critical' ? '#fee2e2' : l === 'high' ? '#ffedd5' : '#fef3c7';
  if (!alerts.length) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.green, marginBottom: 4 }}>No Critical Alerts</div>
        <div style={{ fontSize: 13, color: C.gray }}>All project parameters are within acceptable ranges.</div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ padding: '12px 16px', background: '#fee2e2', borderRadius: 12, borderLeft: '4px solid #dc2626', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>🚨</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.red }}>War Room — {alerts.length} Active Alert{alerts.length > 1 ? 's' : ''}</div>
          <div style={{ fontSize: 12, color: '#b91c1c' }}>Immediate executive attention required</div>
        </div>
      </div>

      {alerts.map((a, i) => (
        <div key={i} style={{ ...C.card, borderLeft: `4px solid ${levelColor(a.level)}`, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', background: levelBg(a.level), display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>{a.level === 'critical' ? '🔴' : '🟠'}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>
                <Badge label={a.type} color={levelColor(a.level)} bg={levelBg(a.level)} /> &nbsp;{a.msg}
              </div>
            </div>
            <Badge label={a.level.toUpperCase()} color={levelColor(a.level)} bg={levelBg(a.level)} />
          </div>
          {a.items?.length > 0 && (
            <div style={{ padding: '10px 16px' }}>
              {a.items.map((item, j) => (
                <div key={j} style={{ fontSize: 12, color: '#374151', padding: '3px 0', borderBottom: j < a.items.length - 1 ? '1px solid #f0f0f4' : 'none' }}>
                  → {item}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div style={{ padding: '14px 16px', background: '#f5f3ff', borderRadius: 12, border: `1px solid ${C.border}` }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: C.primary, marginBottom: 8 }}>📋 Executive Escalation Checklist</div>
        {alerts.map((a, i) => (
          <div key={i} style={{ fontSize: 12, color: '#374151', padding: '4px 0', display: 'flex', gap: 8 }}>
            <span style={{ color: C.red }}>□</span>
            <span>{a.type}: {a.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab: AI Copilot ───────────────────────────────────────────────────────────
function TabAI({ projectId, projectNumber }) {
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState([]);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  const QUICK = [
    'Why is the project delayed?',
    'Which materials are blocking?',
    'Which suppliers are risky?',
    'What is the current margin?',
    'What tasks are overdue?',
    'When will the project finish?',
    'What NCRs are open?',
    'Generate executive summary',
  ];

  const ask = useCallback(async (q) => {
    const text = q || question.trim();
    if (!text || loading) return;
    setQuestion('');
    setChat(c => [...c, { role: 'user', text }]);
    setLoading(true);
    try {
      const res = await api.post(`/project-360/${projectId}/ask`, { question: text });
      setChat(c => [...c, { role: 'ai', text: res.data.answer }]);
    } catch {
      setChat(c => [...c, { role: 'ai', text: '⚠️ Unable to process. Please try again.' }]);
    } finally {
      setLoading(false);
    }
  }, [projectId, question, loading]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <div style={{ padding: '12px 16px', background: 'linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%)', borderRadius: 12, border: `1px solid ${C.border}` }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: C.primary, marginBottom: 4 }}>🤖 Project AI Copilot</div>
        <div style={{ fontSize: 12, color: C.gray }}>Ask anything about {projectNumber} — delays, costs, materials, risks, or get an executive summary.</div>
      </div>

      {/* Quick questions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {QUICK.map((q, i) => (
          <button key={i} onClick={() => ask(q)} style={{
            padding: '6px 12px', fontSize: 11, fontWeight: 500,
            border: `1px solid ${C.border}`, borderRadius: 20,
            background: '#fff', color: '#374151', cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}>{q}</button>
        ))}
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, minHeight: 200, maxHeight: 400, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: 4 }}>
        {chat.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: C.gray }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
            <div style={{ fontSize: 13 }}>Click a quick question or type your own</div>
          </div>
        )}
        {chat.map((msg, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth: '80%', padding: '10px 14px',
              borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
              background: msg.role === 'user' ? C.primary : '#f3f4f6',
              color: msg.role === 'user' ? '#fff' : '#111827',
              fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-line',
            }}>
              {msg.role === 'ai' && <div style={{ fontSize: 10, fontWeight: 700, color: C.primary, marginBottom: 4 }}>🤖 AI COPILOT</div>}
              {msg.text}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ padding: '10px 14px', borderRadius: 12, background: '#f3f4f6', fontSize: 13, color: C.gray }}>
              🤖 Analyzing project data…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && ask()}
          placeholder="Ask about this project…"
          style={{
            flex: 1, padding: '10px 14px', border: `1px solid ${C.border}`, borderRadius: 8,
            fontSize: 13, outline: 'none', fontFamily: 'inherit',
          }}
        />
        <button onClick={() => ask()} disabled={loading || !question.trim()} style={{
          padding: '10px 20px', background: C.primary, color: '#fff',
          border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
          cursor: loading || !question.trim() ? 'not-allowed' : 'pointer',
          opacity: loading || !question.trim() ? 0.6 : 1,
        }}>
          {loading ? '…' : 'Ask'}
        </button>
      </div>
    </div>
  );
}

// ── Health Widget ─────────────────────────────────────────────────────────────
function HealthWidget({ health }) {
  const [expanded, setExpanded] = useState(false);
  if (!health) return null;
  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 10px', borderRadius: 8, background: health.color + '15', border: `1px solid ${health.color}44` }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: health.color, lineHeight: 1 }}>{health.overall}</div>
          <div style={{ fontSize: 9, color: health.color, fontWeight: 600 }}>HEALTH</div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: health.color }}>{health.label}</div>
          <div style={{ fontSize: 9, color: C.gray }}>▼ details</div>
        </div>
      </div>
      {expanded && (
        <div style={{ position: 'absolute', right: 0, top: '110%', width: 220, ...C.card, padding: 14, zIndex: 99, boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: '#111827', marginBottom: 10 }}>Health Score Breakdown</div>
          {[
            ['Schedule',       health.schedule],
            ['Budget',         health.budget],
            ['Quality',        health.quality],
            ['Procurement',    health.procurement],
            ['Production',     health.production],
            ['Commissioning',  health.commissioning],
            ['Service',        health.service],
          ].map(([label, score]) => (
            <ScoreBar key={label} label={label} score={score} />
          ))}
          <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 8, paddingTop: 8 }}>
            <ScoreBar label="Overall Health" score={health.overall} color={health.color} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function Project360() {
  const [projects, setProjects]     = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [data, setData]             = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [tab, setTab]               = useState('overview');
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadProjects = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await api.get('/projects/projects', { params: { limit: 200 } });
      if (!mountedRef.current) return;
      const rows = Array.isArray(res.data) ? res.data : (res.data?.rows || []);
      const filtered = search
        ? rows.filter(p => (p.project_number + p.name + (p.customer_name||'')).toLowerCase().includes(search.toLowerCase()))
        : rows;
      setProjects(filtered);
      if (!selectedId && filtered.length > 0) setSelectedId(filtered[0].id);
    } catch { if (mountedRef.current) setProjects([]); }
    finally  { if (mountedRef.current) setListLoading(false); }
  }, [search]);

  const loadProject = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setData(null);
    try {
      const res = await api.get(`/project-360/${id}`);
      if (mountedRef.current) setData(res.data);
    } catch { if (mountedRef.current) setData(null); }
    finally  { if (mountedRef.current) setLoading(false); }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { if (selectedId) { loadProject(selectedId); setTab('overview'); } }, [selectedId, loadProject]);

  const proj    = data?.project || {};
  const health  = data?.health;
  const alerts  = data?.alerts || [];

  const statusColor = s => ({
    active: C.green, completed: C.gray, planning: C.blue, on_hold: C.amber, cancelled: C.red,
  }[s] || C.gray);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', fontFamily: 'inherit', overflow: 'hidden' }}>

      {/* ── Left: Project List ──────────────────────────────────────────────── */}
      <div style={{ width: 270, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fafafa', flexShrink: 0 }}>
        <div style={{ padding: '14px 12px 10px', borderBottom: `1px solid ${C.border}`, background: '#fff' }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#111827', marginBottom: 8 }}>Project 360°</div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadProjects()}
            placeholder="Search projects…"
            style={{ width: '100%', padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, boxSizing: 'border-box', outline: 'none' }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {listLoading ? (
            <div style={{ padding: 20, color: C.gray, textAlign: 'center', fontSize: 12 }}>Loading…</div>
          ) : projects.map(p => (
            <div key={p.id} onClick={() => setSelectedId(p.id)} style={{
              padding: '10px 12px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer',
              background: selectedId === p.id ? C.light : '#fff',
              borderLeft: selectedId === p.id ? `3px solid ${C.primary}` : '3px solid transparent',
            }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: '#111827', marginBottom: 1 }}>{p.project_number || p.name}</div>
              <div style={{ fontSize: 11, color: C.gray, marginBottom: 3 }}>{p.name}</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: statusColor(p.status), fontWeight: 600 }}>{(p.status||'').toUpperCase()}</span>
                {p.completion_percentage > 0 && <span style={{ fontSize: 10, color: C.gray }}>{p.completion_percentage}%</span>}
              </div>
            </div>
          ))}
          {!listLoading && projects.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: C.gray, fontSize: 12 }}>No projects found</div>}
        </div>
      </div>

      {/* ── Right: Detail Panel ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selectedId ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray }}>
            <div style={{ textAlign: 'center' }}><div style={{ fontSize: 48, marginBottom: 12 }}>📋</div><div style={{ fontWeight: 600 }}>Select a project</div></div>
          </div>
        ) : loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray }}>Loading project intelligence…</div>
        ) : !data ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.red }}>Failed to load project data</div>
        ) : (
          <>
            {/* ── Sticky Header ─────────────────────────────────────────────── */}
            <div style={{ background: '#fff', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
              {/* Top row: project identity */}
              <div style={{ padding: '12px 20px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 300 }}>
                      {proj.name}
                    </h2>
                    <span style={{ fontSize: 12, fontWeight: 700, color: C.primary }}>{proj.project_number}</span>
                    {statusBadge(proj.status)}
                    {alerts.length > 0 && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: C.red, background: '#fee2e2', padding: '2px 8px', borderRadius: 10 }}>
                        🚨 {alerts.length} Alert{alerts.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginTop: 5, flexWrap: 'wrap', fontSize: 11, color: C.gray }}>
                    {proj.customer_name && <span>👤 {proj.customer_name}</span>}
                    {proj.site_name && <span>📍 {proj.site_name}</span>}
                    {proj.project_manager && <span>🧑‍💼 PM: {proj.project_manager}</span>}
                    {proj.po_number && <span>📦 PO: {proj.po_number}</span>}
                    {proj.start_date && <span>🗓 {fmtDate(proj.start_date)} → {fmtDate(proj.end_date)}</span>}
                  </div>
                </div>

                {/* Right: KPIs + Health */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexShrink: 0 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: C.primary }}>{fmtINR(proj.contract_value)}</div>
                    <div style={{ fontSize: 10, color: C.gray }}>Contract Value</div>
                    {proj.completion_pct > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <div style={{ width: 120, background: '#f3f4f6', borderRadius: 4, height: 5 }}>
                          <div style={{ width: `${Math.min(proj.completion_pct, 100)}%`, background: C.green, height: 5, borderRadius: 4 }} />
                        </div>
                        <div style={{ fontSize: 10, color: C.gray, marginTop: 1 }}>{proj.completion_pct}% complete</div>
                      </div>
                    )}
                  </div>
                  <HealthWidget health={health} />
                </div>
              </div>

              {/* Quick Actions row */}
              <div style={{ padding: '8px 20px 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  { label: '🚨 War Room', action: () => setTab('warroom'), alert: alerts.length > 0 },
                  { label: '🤖 AI Copilot', action: () => setTab('ai') },
                  { label: '📅 Timeline', action: () => setTab('timeline') },
                  { label: '📈 Profitability', action: () => setTab('profitability') },
                  { label: '⚠️ Risks', action: () => setTab('risks') },
                ].map((a, i) => (
                  <button key={i} onClick={a.action} style={{
                    padding: '4px 10px', fontSize: 11, fontWeight: 600,
                    border: `1px solid ${a.alert ? C.red : C.border}`,
                    borderRadius: 6, background: a.alert ? '#fee2e2' : '#fff',
                    color: a.alert ? C.red : '#374151', cursor: 'pointer',
                  }}>{a.label}</button>
                ))}
              </div>

              {/* Tab Navigation */}
              <div style={{ display: 'flex', overflowX: 'auto', padding: '6px 20px 0', gap: 0, scrollbarWidth: 'none' }}>
                {TABS.map(t => (
                  <button key={t.id} onClick={() => setTab(t.id)} style={{
                    padding: '6px 12px', border: 'none', background: 'none', cursor: 'pointer',
                    whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600,
                    color: tab === t.id ? C.primary : C.gray,
                    borderBottom: tab === t.id ? `2px solid ${C.primary}` : '2px solid transparent',
                    marginBottom: -1, display: 'flex', alignItems: 'center', gap: 4,
                    ...(t.id === 'warroom' && alerts.length > 0 ? { color: C.red } : {}),
                  }}>
                    <span>{t.icon}</span> {t.label}
                    {t.id === 'warroom' && alerts.length > 0 && (
                      <span style={{ background: C.red, color: '#fff', borderRadius: 10, fontSize: 9, padding: '1px 5px', fontWeight: 700 }}>{alerts.length}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Tab Content ────────────────────────────────────────────────── */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 20, background: '#f9f9fb' }}>
              {tab === 'overview'      && <TabOverview        data={data} />}
              {tab === 'sales'         && <TabSales           data={data} />}
              {tab === 'engineering'   && <TabEngineering     data={data} />}
              {tab === 'procurement'   && <TabProcurement     data={data} />}
              {tab === 'inventory'     && <TabInventory       data={data} />}
              {tab === 'manufacturing' && <TabManufacturing   data={data} />}
              {tab === 'quality'       && <TabQuality         data={data} />}
              {tab === 'logistics'     && <TabLogistics       data={data} />}
              {tab === 'installation'  && <TabInstallation    data={data} />}
              {tab === 'commissioning' && <TabCommissioning   data={data} />}
              {tab === 'service'       && <TabService         data={data} />}
              {tab === 'amc'           && <TabAMC             data={data} />}
              {tab === 'cost'          && <TabCost            data={data} />}
              {tab === 'profitability' && <TabProfitability   data={data} />}
              {tab === 'travel'        && <TabTravel          data={data} />}
              {tab === 'documents'     && <TabDocuments       data={data} />}
              {tab === 'timeline'      && <TabTimeline        data={data} />}
              {tab === 'risks'         && <TabRisks           data={data} />}
              {tab === 'warroom'       && <TabWarRoom         data={data} />}
              {tab === 'ai'            && <TabAI              projectId={selectedId} projectNumber={proj.project_number} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
