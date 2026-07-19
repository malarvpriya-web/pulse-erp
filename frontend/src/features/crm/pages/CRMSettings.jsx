import React, { useState, useEffect, useRef } from 'react';
import {
  Handshake, Target, GitBranch, Mail,
  Zap, BarChart2, Settings, X, Plus,
} from 'lucide-react';
import ModuleSettingsShell, {
  SectionCard, Row, Toggle, selectStyle, inputStyle,
} from '@/features/_shared/ModuleSettingsShell';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const COLOR = '#6B3FDB';

const SECTIONS = [
  { id: 'general',    label: 'General',          icon: Settings,  color: '#6B3FDB' },
  { id: 'leads',      label: 'Lead Config',       icon: Target,    color: '#0369a1' },
  { id: 'pipeline',   label: 'Pipeline & Deals',  icon: GitBranch, color: '#10b981' },
  { id: 'email',      label: 'Email & Comms',     icon: Mail,      color: '#f59e0b' },
  { id: 'automation', label: 'Automation',        icon: Zap,       color: '#ef4444' },
  { id: 'reports',    label: 'Reports',           icon: BarChart2, color: '#a78bfa' },
];

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];

const FISCAL_MONTHS = [
  { value: 1,  label: 'January'  }, { value: 2,  label: 'February' },
  { value: 3,  label: 'March'    }, { value: 4,  label: 'April'    },
  { value: 5,  label: 'May'      }, { value: 6,  label: 'June'     },
  { value: 7,  label: 'July'     }, { value: 8,  label: 'August'   },
  { value: 9,  label: 'September'}, { value: 10, label: 'October'  },
  { value: 11, label: 'November' }, { value: 12, label: 'December' },
];

const CLOSE_FIELDS = [
  { key: 'value',               label: 'Deal Value' },
  { key: 'expected_close_date', label: 'Expected Close Date' },
  { key: 'assigned_to',         label: 'Assigned To' },
  { key: 'account',             label: 'Account' },
  { key: 'stage',               label: 'Stage' },
];

const REPORT_PERIODS = [
  { value: 'this_month',   label: 'This Month' },
  { value: 'last_month',   label: 'Last Month' },
  { value: 'this_quarter', label: 'This Quarter' },
  { value: 'last_quarter', label: 'Last Quarter' },
  { value: 'this_year',    label: 'This Year' },
];

const DEFAULT_SETTINGS = {
  // General
  default_currency:            'INR',
  deal_scoring_enabled:        true,
  lead_lifetime_days:          90,
  auto_assign_owner:           false,
  duplicate_detection:         true,
  activity_reminders:          true,
  // Lead Config
  lead_sources:                ['Website', 'Referral', 'LinkedIn', 'Cold Call', 'Exhibition', 'Direct'],
  lead_statuses:               ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted'],
  default_lead_score:          0,
  auto_score_on_create:        true,
  // Pipeline & Deals
  fiscal_year_start:           4,
  deal_probability_auto_update: true,
  show_lost_reasons:           true,
  show_win_reasons:            true,
  required_fields_to_close:   ['value', 'expected_close_date'],
  // Email & Comms
  email_tracking_enabled:      false,
  email_open_tracking:         false,
  email_click_tracking:        false,
  bcc_crm_email:               '',
  // Automation
  lead_assignment_method:      'manual',
  stale_lead_alert_days:       7,
  auto_close_lost_after_days:  0,
  // Reports
  default_report_period:       'this_month',
  include_lost_in_pipeline:    false,
};

function TagEditor({ values = [], onChange, placeholder, color = '#6B3FDB' }) {
  const [input, setInput] = useState('');

  const add = () => {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput('');
  };

  return (
    <div style={{ maxWidth: 280 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {values.map(tag => (
          <span key={tag} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 500,
            background: `${color}18`, color, border: `1px solid ${color}40`,
          }}>
            {tag}
            <button
              onClick={() => onChange(values.filter(t => t !== tag))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', lineHeight: 1 }}
            >
              <X size={11} color={color} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          style={{ ...inputStyle, flex: 1, fontSize: 12 }}
        />
        <button
          onClick={add}
          style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${color}`, background: `${color}15`, color, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

export default function CRMSettings() {
  const [active, setActive]     = useState('general');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isDirty, setIsDirty]   = useState(false);
  const [saved, setSaved]       = useState(false);
  const original                = useRef(DEFAULT_SETTINGS);
  const toast                   = useToast();

  useEffect(() => {
    const controller = new AbortController();
    api.get('/crm/settings', { signal: controller.signal })
      .then(res => {
        const data = res.data?.data;
        if (data) {
          const merged = { ...DEFAULT_SETTINGS, ...data };
          setSettings(merged);
          original.current = merged;
        }
      })
      .catch(e => { if (e.name !== 'CanceledError') console.error('CRM settings load failed', e); });
    return () => controller.abort();
  }, []);

  const update = (field, value) => {
    setSettings(s => ({ ...s, [field]: value }));
    setIsDirty(true);
  };

  const handleSave = async () => {
    try {
      await api.put('/crm/settings', settings);
      original.current = settings;
      setIsDirty(false);
      setSaved(true);
      toast.success('CRM settings saved');
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to save settings');
    }
  };

  // Per-tab save button: calls the unified handleSave, disabled when nothing changed
  const SaveButton = ({ color: btnColor }) => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20, paddingTop: 16, borderTop: '1px solid #f0f0f4' }}>
      <button
        onClick={handleSave}
        disabled={!isDirty}
        style={{
          background: saved ? '#16a34a' : btnColor,
          color: '#fff', border: 'none', borderRadius: 8,
          padding: '9px 22px', fontWeight: 600, fontSize: 14,
          cursor: isDirty ? 'pointer' : 'not-allowed',
          opacity: isDirty ? 1 : 0.5,
          display: 'flex', alignItems: 'center', gap: 6,
          transition: 'background 0.2s, opacity 0.2s',
        }}
      >
        {saved ? '✓ Saved' : 'Save Changes'}
      </button>
    </div>
  );

  const S = settings;

  function renderSection() {
    switch (active) {
      case 'general': return (
        <SectionCard icon={Settings} color="#6B3FDB" label="General Settings">
          <Row label="Default Currency" desc="Base currency for deal values and forecasting">
            <select value={S.default_currency} onChange={e => update('default_currency', e.target.value)} style={selectStyle}>
              {CURRENCIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </Row>
          <Row label="Deal Scoring" desc="Score deals based on activity and stage progression">
            <Toggle checked={!!S.deal_scoring_enabled} onChange={v => update('deal_scoring_enabled', v)} color={COLOR} />
          </Row>
          <Row label="Lead Lifetime (days)" desc="Days before an untouched lead is marked stale">
            <input type="number" value={S.lead_lifetime_days} min={7} max={365}
              onChange={e => update('lead_lifetime_days', +e.target.value)}
              style={{ ...inputStyle, width: 70 }} />
          </Row>
          <Row label="Auto-Assign Owner" desc="Automatically assign new leads to a sales rep">
            <Toggle checked={!!S.auto_assign_owner} onChange={v => update('auto_assign_owner', v)} color={COLOR} />
          </Row>
          <Row label="Duplicate Detection" desc="Warn when creating a lead/contact that matches an existing record">
            <Toggle checked={!!S.duplicate_detection} onChange={v => update('duplicate_detection', v)} color={COLOR} />
          </Row>
          <Row label="Activity Reminders" desc="Send reminders for overdue CRM activities">
            <Toggle checked={!!S.activity_reminders} onChange={v => update('activity_reminders', v)} color={COLOR} />
          </Row>
          <SaveButton color="#6B3FDB" />
        </SectionCard>
      );

      case 'leads': return (
        <SectionCard icon={Target} color="#0369a1" label="Lead Configuration">
          <Row label="Lead Sources" desc="Sources available when creating a lead">
            <TagEditor
              values={S.lead_sources ?? []}
              onChange={v => update('lead_sources', v)}
              placeholder="Add source…"
              color="#0369a1"
            />
          </Row>
          <Row label="Lead Statuses" desc="Status values for the lead lifecycle">
            <TagEditor
              values={S.lead_statuses ?? []}
              onChange={v => update('lead_statuses', v)}
              placeholder="Add status…"
              color="#0369a1"
            />
          </Row>
          <Row label="Default Lead Score" desc="Starting score assigned to newly created leads (0–100)">
            <input type="number" value={S.default_lead_score} min={0} max={100}
              onChange={e => update('default_lead_score', +e.target.value)}
              style={{ ...inputStyle, width: 70 }} />
          </Row>
          <Row label="Auto-Score on Create" desc="Calculate initial score when a lead is first created">
            <Toggle checked={!!S.auto_score_on_create} onChange={v => update('auto_score_on_create', v)} color="#0369a1" />
          </Row>
          <SaveButton color="#0369a1" />
        </SectionCard>
      );

      case 'pipeline': return (
        <SectionCard icon={GitBranch} color="#10b981" label="Pipeline & Deals">
          <Row label="Fiscal Year Start" desc="Month the financial year begins — April (4) for India">
            <select value={S.fiscal_year_start} onChange={e => update('fiscal_year_start', +e.target.value)} style={selectStyle}>
              {FISCAL_MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Row>
          <Row label="Deal Probability Auto-Update" desc="Recalculate win probability automatically as deal stage changes">
            <Toggle checked={!!S.deal_probability_auto_update} onChange={v => update('deal_probability_auto_update', v)} color="#10b981" />
          </Row>
          <Row label="Show Lost Reasons" desc="Require a reason when marking a deal as Lost">
            <Toggle checked={!!S.show_lost_reasons} onChange={v => update('show_lost_reasons', v)} color="#10b981" />
          </Row>
          <Row label="Show Win Reasons" desc="Require a reason when marking a deal as Won">
            <Toggle checked={!!S.show_win_reasons} onChange={v => update('show_win_reasons', v)} color="#10b981" />
          </Row>
          <Row label="Required Fields to Close" desc="Fields that must be filled before a deal can be closed">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {CLOSE_FIELDS.map(f => (
                <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
                  <input
                    type="checkbox"
                    checked={(S.required_fields_to_close ?? []).includes(f.key)}
                    onChange={e => {
                      const cur = S.required_fields_to_close ?? [];
                      update('required_fields_to_close',
                        e.target.checked ? [...cur, f.key] : cur.filter(k => k !== f.key));
                    }}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </Row>
          <SaveButton color="#10b981" />
        </SectionCard>
      );

      case 'email': return (
        <SectionCard icon={Mail} color="#f59e0b" label="Email & Communications">
          <Row label="Email Tracking" desc="Enable tracking for CRM outbound emails">
            <Toggle checked={!!S.email_tracking_enabled} onChange={v => update('email_tracking_enabled', v)} color="#f59e0b" />
          </Row>
          <Row label="Email Open Tracking" desc="Track when CRM emails are opened by the recipient">
            <Toggle checked={!!S.email_open_tracking} onChange={v => update('email_open_tracking', v)} color="#f59e0b" />
          </Row>
          <Row label="Link Click Tracking" desc="Track link clicks in outbound CRM emails">
            <Toggle checked={!!S.email_click_tracking} onChange={v => update('email_click_tracking', v)} color="#f59e0b" />
          </Row>
          <Row label="BCC Email" desc="Automatically BCC this address on all CRM emails sent">
            <input
              type="email"
              value={S.bcc_crm_email ?? ''}
              placeholder="bcc@company.com"
              onChange={e => update('bcc_crm_email', e.target.value)}
              style={{ ...inputStyle, width: 210 }}
            />
          </Row>
          <SaveButton color="#f59e0b" />
        </SectionCard>
      );

      case 'automation': return (
        <SectionCard icon={Zap} color="#ef4444" label="Automation">
          <Row label="Lead Assignment Method" desc="How new leads are distributed to the sales team">
            <select value={S.lead_assignment_method} onChange={e => update('lead_assignment_method', e.target.value)} style={selectStyle}>
              <option value="manual">Manual</option>
              <option value="round_robin">Round Robin</option>
              <option value="load_balanced">Load Balanced</option>
            </select>
          </Row>
          <Row label="Stale Lead Alert (days)" desc="Alert after this many days with no activity on a lead">
            <input type="number" value={S.stale_lead_alert_days} min={1} max={90}
              onChange={e => update('stale_lead_alert_days', +e.target.value)}
              style={{ ...inputStyle, width: 70 }} />
          </Row>
          <Row label="Auto-Close Lost After (days)" desc="Mark stale leads as Lost after N days of no activity — 0 to disable">
            <input type="number" value={S.auto_close_lost_after_days} min={0} max={365}
              onChange={e => update('auto_close_lost_after_days', +e.target.value)}
              style={{ ...inputStyle, width: 70 }} />
          </Row>
          <SaveButton color="#ef4444" />
        </SectionCard>
      );

      case 'reports': return (
        <SectionCard icon={BarChart2} color="#a78bfa" label="Reports">
          <Row label="Default Report Period" desc="Pre-selected time range when opening CRM reports">
            <select value={S.default_report_period} onChange={e => update('default_report_period', e.target.value)} style={selectStyle}>
              {REPORT_PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Row>
          <Row label="Include Lost in Pipeline" desc="Count closed-lost deals in pipeline and conversion metrics">
            <Toggle checked={!!S.include_lost_in_pipeline} onChange={v => update('include_lost_in_pipeline', v)} color="#a78bfa" />
          </Row>
          <SaveButton color="#a78bfa" />
        </SectionCard>
      );

      default: return null;
    }
  }

  return (
    <ModuleSettingsShell
      title="CRM Settings"
      subtitle="Configure leads, pipeline stages, email sync and automation rules"
      icon={Handshake}
      color={COLOR}
      sections={SECTIONS}
      activeSection={active}
      onSectionChange={setActive}
    >
      {renderSection()}
    </ModuleSettingsShell>
  );
}
