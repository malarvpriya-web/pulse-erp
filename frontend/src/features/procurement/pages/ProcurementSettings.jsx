import { useState, useEffect, useRef } from 'react';
import { Settings, CheckCircle, Link2, Hash, Bell, ShoppingBag, Tag, BarChart2, Shield, Globe, Scale, X, Plus } from 'lucide-react';
import ModuleSettingsShell, {
  SectionCard, Row, Toggle, inputStyle,
} from '@/features/_shared/ModuleSettingsShell';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const PURPLE = '#6B3FDB';

const fmtINR = n => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const DEFAULT_VENDOR_CATEGORIES = [
  'Raw Materials',
  'Electronic Components (Active)',
  'Electronic Components (Passive)',
  'IGBT / Power Modules',
  'PCB Manufacturers',
  'Magnetics (Transformers / Inductors)',
  'Contract Manufacturers (EMS)',
  'Consumables',
  'IT',
  'Services',
  'Logistics',
  'Import Agents / CHA',
];

const DEFAULT_SETTINGS = {
  default_payment_terms_days:   30,
  auto_approve_below:           5000,
  grn_qty_tolerance_pct:        5,
  min_vendor_rating:            3,
  l1_approval_limit:            25000,
  l2_approval_limit:            100000,
  cfo_approval_above:           500000,
  enforce_3way_match:           false,
  block_payment_on_mismatch:    false,
  allowable_price_variance_pct: 3,
  pr_prefix:                    'PR',
  po_prefix:                    'PO',
  grn_prefix:                   'GRN',
  rfq_prefix:                   'RFQ',
  notify_po_approval:           false,
  notify_grn_receipt:           false,
  alert_vendor_rating_drop:     false,
  alert_overdue_delivery:       false,
  // Vendor categories
  vendor_categories:            DEFAULT_VENDOR_CATEGORIES,
  // MRP rules
  default_safety_stock_days:    7,
  default_lead_time_days:       14,
  mrp_auto_suggest_pr:          false,
  // Quality rules
  require_quality_inspection:   false,
  auto_ncr_on_rejection:        false,
  inspection_sample_pct:        100,
  // Currency
  default_currency:             'INR',
  enable_multi_currency:        false,
  // Total cost of ownership — mirrors backend TCO_DEFAULTS in
  // modules/procurement/engines/tcoEngine.js. Keep the two in step: the
  // backend is authoritative, these only stop the inputs rendering blank
  // before the first GET resolves.
  tco_enabled:                  true,
  cost_of_capital_pct:          12,
  inventory_carrying_pct:       18,
  ordering_cost_per_po:         750,
  inspection_cost_per_receipt:  500,
  expedite_cost_per_late_order: 2500,
  rework_cost_pct:              25,
  default_freight_pct:          2,
  gst_input_credit_pct:         100,
  single_source_risk_pct:       2,
  service_level_z:              1.65,
  tco_horizon_months:           12,
};

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED', 'JPY', 'CNY'];

const SECTIONS = [
  { id: 'general',       label: 'General',             icon: Settings,    color: PURPLE    },
  { id: 'approvals',     label: 'Approval Thresholds', icon: CheckCircle, color: '#0369a1' },
  { id: 'three_way',     label: '3-Way Match',          icon: Link2,       color: '#10b981' },
  { id: 'numbering',     label: 'Numbering Series',     icon: Hash,        color: '#7c5cf0' },
  { id: 'notifications', label: 'Notifications',        icon: Bell,        color: '#ef4444' },
  { id: 'vendor_cats',   label: 'Vendor Categories',    icon: Tag,         color: '#8b5cf6' },
  { id: 'mrp',           label: 'MRP Rules',            icon: BarChart2,   color: '#0284c7' },
  { id: 'quality',       label: 'Quality Rules',        icon: Shield,      color: '#16a34a' },
  { id: 'tco',           label: 'Total Cost of Ownership', icon: Scale,     color: '#0d9488' },
  { id: 'currency',      label: 'Currency',             icon: Globe,       color: '#6d28d9' },
];

export default function ProcurementSettings() {
  const [active,   setActive]   = useState('general');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isDirty,  setIsDirty]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [newCat,   setNewCat]   = useState('');
  const original                = useRef(DEFAULT_SETTINGS);
  const toast                   = useToast();

  useEffect(() => {
    const controller = new AbortController();
    api.get('/procurement/settings', { signal: controller.signal })
      .then(res => {
        const data = res.data?.data ?? DEFAULT_SETTINGS;
        const merged = { ...DEFAULT_SETTINGS, ...data };
        setSettings(merged);
        original.current = merged;
      })
      .catch(e => { if (e.name !== 'CanceledError') console.error('Procurement settings load failed', e); });
    return () => controller.abort();
  }, []);

  const update = (key, val) => {
    setSettings(s => ({ ...s, [key]: val }));
    setIsDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/procurement/settings', settings);
      original.current = { ...settings };
      setIsDirty(false);
      toast.success('Procurement settings saved');
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setSettings({ ...original.current });
    setIsDirty(false);
  };

  const S = settings;

  const NumInput = ({ field, min = 0, step = 1 }) => (
    <input
      type="number"
      value={S[field] ?? ''}
      min={min}
      step={step}
      onChange={e => update(field, +e.target.value)}
      style={{ ...inputStyle, width: 130, textAlign: 'right' }}
    />
  );

  const TxtInput = ({ field, placeholder }) => (
    <input
      type="text"
      value={S[field] ?? ''}
      placeholder={placeholder}
      maxLength={10}
      onChange={e => update(field, e.target.value)}
      style={{ ...inputStyle, width: 90, textAlign: 'center', fontFamily: 'monospace', letterSpacing: 1 }}
    />
  );

  const SaveBar = ({ color }) => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24, paddingTop: 16, borderTop: '1px solid #f0f0f4' }}>
      <button
        onClick={handleCancel}
        disabled={!isDirty}
        style={{
          padding: '8px 18px', borderRadius: 8, border: '1px solid #e5e7eb',
          background: '#fff', color: '#374151', fontWeight: 600, fontSize: 13,
          cursor: isDirty ? 'pointer' : 'not-allowed', opacity: isDirty ? 1 : 0.4,
        }}
      >Cancel</button>
      <button
        onClick={handleSave}
        disabled={!isDirty || saving}
        style={{
          padding: '8px 22px', borderRadius: 8, border: 'none',
          background: isDirty && !saving ? color : '#d1d5db',
          color: '#fff', fontWeight: 600, fontSize: 13,
          cursor: isDirty && !saving ? 'pointer' : 'not-allowed',
        }}
      >{saving ? 'Saving…' : 'Save Settings'}</button>
    </div>
  );

  function renderSection() {
    switch (active) {
      case 'general':
        return (
          <SectionCard icon={Settings} color={PURPLE} label="General Settings">
            <Row label="Default Payment Terms (days)" desc="Days allowed for vendor payment after PO is raised">
              <NumInput field="default_payment_terms_days" />
            </Row>
            <Row label="Auto-approve PO below (₹)" desc={`POs under ${fmtINR(S.auto_approve_below)} skip approval`}>
              <NumInput field="auto_approve_below" step={500} />
            </Row>
            <Row label="GRN Quantity Tolerance (%)" desc="Acceptable % deviation on goods received vs ordered">
              <NumInput field="grn_qty_tolerance_pct" step={0.5} />
            </Row>
            <Row label="Min Vendor Rating to Issue PO" desc="Vendors below this score cannot receive new POs">
              <NumInput field="min_vendor_rating" min={1} step={0.5} />
            </Row>
            <SaveBar color={PURPLE} />
          </SectionCard>
        );

      case 'approvals':
        return (
          <SectionCard icon={CheckCircle} color="#0369a1" label="Approval Thresholds">
            <Row label="L1 Approval Limit (₹)" desc={`Manager can approve up to ${fmtINR(S.l1_approval_limit)}`}>
              <NumInput field="l1_approval_limit" step={1000} />
            </Row>
            <Row label="L2 Approval Limit (₹)" desc={`Senior manager can approve up to ${fmtINR(S.l2_approval_limit)}`}>
              <NumInput field="l2_approval_limit" step={5000} />
            </Row>
            <Row label="CFO Approval Above (₹)" desc={`CFO sign-off required above ${fmtINR(S.cfo_approval_above)}`}>
              <NumInput field="cfo_approval_above" step={10000} />
            </Row>
            <SaveBar color="#0369a1" />
          </SectionCard>
        );

      case 'three_way':
        return (
          <SectionCard icon={Link2} color="#10b981" label="3-Way Match">
            <Row label="Enforce 3-way match on all POs" desc="PO, GRN, and vendor invoice must match before payment is released">
              <Toggle checked={!!S.enforce_3way_match} onChange={v => update('enforce_3way_match', v)} color="#10b981" />
            </Row>
            <Row label="Block payment on mismatch" desc="Prevent payment processing when PO, GRN, or invoice values differ">
              <Toggle checked={!!S.block_payment_on_mismatch} onChange={v => update('block_payment_on_mismatch', v)} color="#10b981" />
            </Row>
            <Row label="Allowable Price Variance (%)" desc="Max % difference permitted between PO price and invoice price">
              <NumInput field="allowable_price_variance_pct" step={0.5} />
            </Row>
            <SaveBar color="#10b981" />
          </SectionCard>
        );

      case 'numbering':
        return (
          <SectionCard icon={Hash} color="#7c5cf0" label="Numbering Series">
            <Row label="Purchase Request Prefix" desc="Prefix used when generating PR numbers (e.g. PR-2024-001)">
              <TxtInput field="pr_prefix" placeholder="PR" />
            </Row>
            <Row label="Purchase Order Prefix" desc="Prefix used when generating PO numbers (e.g. PO-2024-001)">
              <TxtInput field="po_prefix" placeholder="PO" />
            </Row>
            <Row label="GRN Prefix" desc="Prefix used when generating GRN numbers (e.g. GRN-2024-001)">
              <TxtInput field="grn_prefix" placeholder="GRN" />
            </Row>
            <Row label="RFQ Prefix" desc="Prefix used when generating RFQ numbers (e.g. RFQ-2024-001)">
              <TxtInput field="rfq_prefix" placeholder="RFQ" />
            </Row>
            <SaveBar color="#7c5cf0" />
          </SectionCard>
        );

      case 'notifications':
        return (
          <SectionCard icon={Bell} color="#ef4444" label="Notifications & Alerts">
            <Row label="Notify on PO approval" desc="Send notification to requester when a purchase order is approved">
              <Toggle checked={!!S.notify_po_approval} onChange={v => update('notify_po_approval', v)} color="#ef4444" />
            </Row>
            <Row label="Notify on GRN receipt" desc="Send notification when goods are marked as received">
              <Toggle checked={!!S.notify_grn_receipt} onChange={v => update('notify_grn_receipt', v)} color="#ef4444" />
            </Row>
            <Row label="Alert when vendor rating drops" desc="Trigger alert if a vendor's overall rating falls below the minimum">
              <Toggle checked={!!S.alert_vendor_rating_drop} onChange={v => update('alert_vendor_rating_drop', v)} color="#ef4444" />
            </Row>
            <Row label="Alert on overdue delivery" desc="Notify procurement team when a PO's expected delivery date is exceeded">
              <Toggle checked={!!S.alert_overdue_delivery} onChange={v => update('alert_overdue_delivery', v)} color="#ef4444" />
            </Row>
            <SaveBar color="#ef4444" />
          </SectionCard>
        );

      case 'vendor_cats': {
        const cats = Array.isArray(S.vendor_categories) ? S.vendor_categories : DEFAULT_VENDOR_CATEGORIES;
        const addCat = () => {
          const v = newCat.trim();
          if (!v || cats.includes(v)) return;
          update('vendor_categories', [...cats, v]);
          setNewCat('');
        };
        const removeCat = (c) => update('vendor_categories', cats.filter(x => x !== c));
        return (
          <SectionCard icon={Tag} color="#8b5cf6" label="Vendor Categories">
            <Row label="Manage Categories" desc="Define the categories used to classify vendors and purchase items">
              <div />
            </Row>
            <div style={{ padding: '0 0 16px 0' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                {cats.map(c => (
                  <span key={c} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#ede9fe', color: '#6d28d9', borderRadius: 20, padding: '4px 12px', fontSize: 13, fontWeight: 500 }}>
                    {c}
                    <X size={12} style={{ cursor: 'pointer', opacity: 0.7 }} onClick={() => removeCat(c)} />
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text" value={newCat} onChange={e => setNewCat(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCat()}
                  placeholder="Add new category…"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button onClick={addCat}
                  style={{ padding: '7px 14px', borderRadius: 8, background: '#8b5cf6', border: 'none', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Plus size={14} /> Add
                </button>
              </div>
            </div>
            <SaveBar color="#8b5cf6" />
          </SectionCard>
        );
      }

      case 'mrp':
        return (
          <SectionCard icon={BarChart2} color="#0284c7" label="MRP Rules">
            <Row label="Default Safety Stock (days)" desc="Minimum stock cover to maintain before triggering a reorder">
              <NumInput field="default_safety_stock_days" />
            </Row>
            <Row label="Default Lead Time (days)" desc="Default vendor lead time used in purchase suggestions when not set per-vendor">
              <NumInput field="default_lead_time_days" />
            </Row>
            <Row label="Auto-suggest PR from MRP" desc="Automatically create draft Purchase Requests when stock hits reorder level">
              <Toggle checked={!!S.mrp_auto_suggest_pr} onChange={v => update('mrp_auto_suggest_pr', v)} color="#0284c7" />
            </Row>
            <SaveBar color="#0284c7" />
          </SectionCard>
        );

      case 'quality':
        return (
          <SectionCard icon={Shield} color="#16a34a" label="Quality Rules">
            <Row label="Require Quality Inspection on GRN" desc="All goods receipts must pass a quality inspection before stock is posted">
              <Toggle checked={!!S.require_quality_inspection} onChange={v => update('require_quality_inspection', v)} color="#16a34a" />
            </Row>
            <Row label="Auto-raise NCR on rejection" desc="Automatically create a Non-Conformance Report when rejected qty exceeds zero">
              <Toggle checked={!!S.auto_ncr_on_rejection} onChange={v => update('auto_ncr_on_rejection', v)} color="#16a34a" />
            </Row>
            <Row label="Inspection Sample (%)" desc="Percentage of received qty to inspect (100 = full inspection)">
              <NumInput field="inspection_sample_pct" min={1} step={5} />
            </Row>
            <SaveBar color="#16a34a" />
          </SectionCard>
        );

      // The rates behind every vendor comparison in the app — Component 360's
      // TCO column and the RFQ award modal both read them. A wrong rate here
      // silently changes which vendor a buyer is told to award, so each row
      // says what the number actually drives.
      case 'tco':
        return (
          <SectionCard icon={Scale} color="#0d9488" label="Total Cost of Ownership">
            <Row
              label="Rank vendors by total cost of ownership"
              desc="When off, comparisons fall back to unit price alone — the cheapest quote is not usually the cheapest buy"
            >
              <Toggle checked={!!S.tco_enabled} onChange={v => update('tco_enabled', v)} color="#0d9488" />
            </Row>
            <Row label="Evaluation Horizon (months)" desc="Period one-time costs (tooling) and per-order costs are spread over">
              <NumInput field="tco_horizon_months" min={1} step={1} />
            </Row>
            <Row label="Cost of Capital (% / yr)" desc="Prices the money tied up in stock, and the value of a vendor's credit terms">
              <NumInput field="cost_of_capital_pct" min={0} step={0.5} />
            </Row>
            <Row label="Inventory Carrying Cost (% / yr)" desc="Capital, storage, insurance and obsolescence. A component's own holding_cost_pct overrides this">
              <NumInput field="inventory_carrying_pct" min={0} step={0.5} />
            </Row>
            <Row label="Ordering Cost per PO (₹)" desc={`Raising, approving, chasing and 3-way-matching one PO — ${fmtINR(S.ordering_cost_per_po)}. Penalises a low MOQ that forces frequent buys`}>
              <NumInput field="ordering_cost_per_po" min={0} step={50} />
            </Row>
            <Row label="Incoming Inspection per Receipt (₹)" desc="Cost of inspecting one delivery. Set to 0 for dock-to-stock vendors">
              <NumInput field="inspection_cost_per_receipt" min={0} step={50} />
            </Row>
            <Row label="Expediting per Late Order (₹)" desc="Chasing, part loads and line stoppage when a delivery misses its date. Charged in proportion to the vendor's measured late share">
              <NumInput field="expedite_cost_per_late_order" min={0} step={100} />
            </Row>
            <Row label="Rework on a Reject (%)" desc="Handling and replacement cost on top of losing the part, as a % of its landed cost">
              <NumInput field="rework_cost_pct" min={0} step={5} />
            </Row>
            <Row label="Freight when Unquoted (% of value)" desc="Fallback only — a quoted freight amount, or this vendor's own past freight ratio, always wins">
              <NumInput field="default_freight_pct" min={0} step={0.5} />
            </Row>
            <Row
              label="GST Recoverable as Input Credit (%)"
              desc="At 100% GST is excluded from TCO because it is fully reclaimed. Lower it only where input credit is blocked — the non-creditable share then becomes a real cost"
            >
              <NumInput field="gst_input_credit_pct" min={0} step={5} />
            </Row>
            <Row label="Single-Source Premium (% of spend)" desc="Priced against vendors flagged as the only approved source — no alternative means no leverage and no recovery">
              <NumInput field="single_source_risk_pct" min={0} step={0.5} />
            </Row>
            <Row label="Service Level Factor (z)" desc="Safety-stock cover for lead-time risk. 1.65 ≈ 95% service level, 2.33 ≈ 99%">
              <NumInput field="service_level_z" min={0} step={0.05} />
            </Row>
            <SaveBar color="#0d9488" />
          </SectionCard>
        );

      case 'currency':
        return (
          <SectionCard icon={Globe} color="#6d28d9" label="Currency Settings">
            <Row label="Default Currency" desc="Base currency used for all purchase orders and invoices">
              <select
                value={S.default_currency || 'INR'}
                onChange={e => update('default_currency', e.target.value)}
                style={{ ...inputStyle, width: 100, textAlign: 'center' }}
              >
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Row>
            <Row label="Enable Multi-Currency POs" desc="Allow purchase orders to be issued in foreign currencies with live exchange rates">
              <Toggle checked={!!S.enable_multi_currency} onChange={v => update('enable_multi_currency', v)} color="#6d28d9" />
            </Row>
            <SaveBar color="#6d28d9" />
          </SectionCard>
        );

      default:
        return null;
    }
  }

  return (
    <ModuleSettingsShell
      title="Procurement Settings"
      subtitle="Configure approvals, 3-way match, numbering series, cost-of-ownership rates and notifications"
      icon={ShoppingBag}
      color={PURPLE}
      sections={SECTIONS}
      activeSection={active}
      onSectionChange={id => { setActive(id); }}
    >
      {renderSection()}
    </ModuleSettingsShell>
  );
}
