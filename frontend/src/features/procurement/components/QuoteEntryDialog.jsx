/**
 * QuoteEntryDialog — record or edit an INVITED vendor's RFQ quote (§219).
 *
 * Opened from a vendor row of the RFQ Quotes modal. It first GETs the complete
 * stored quote (the save REPLACES every field, so the form must start from what
 * is stored), then PUTs the whole form back to
 * /procurement/rfqs/:rfqId/quotes/:quoteId. Validation lives on the server
 * (readQuoteBody); the form mirrors the obvious rules so a user is not told
 * after the fact, and shows the server's field-level error verbatim otherwise.
 *
 * Freight is quoted as an amount OR per unit — never both — in its own
 * currency if the vendor stated one. Values are saved exactly as entered;
 * comparisons convert them with approved Finance rates.
 */
import { useState, useEffect } from 'react';
import api from '@/services/api/client';

const MODES = ['road', 'rail', 'air', 'ship'];
const SERVICE_LEVELS = ['FTL', 'LTL', 'FCL', 'LCL'];
const FIELDS = [
  'unit_price', 'total_amount', 'currency', 'delivery_days', 'payment_terms', 'valid_until',
  'vendor_quote_ref', 'quote_date', 'notes',
  'freight_amount', 'freight_per_unit', 'freight_currency', 'insurance_amount', 'duty_amount',
  'packaging_amount', 'other_charges', 'tooling_cost', 'tax_pct', 'warranty_months', 'moq',
  'shipping_weight_kg_per_unit', 'shipping_weight_uom', 'transport_mode', 'service_level',
];
const blankToEmpty = (v) => (v == null ? '' : String(v));

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 };
const panel = { background: '#fff', borderRadius: 14, padding: 24, width: 'min(820px, 96vw)', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 };
const inp = { width: '100%', padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
const lbl = { fontSize: 12, color: '#374151', display: 'block' };
const h = { fontSize: 13, fontWeight: 700, color: '#1f2937', margin: '16px 0 8px' };

export default function QuoteEntryDialog({ rfq, quote, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [meta, setMeta] = useState(null);
  const [freightBasis, setFreightBasis] = useState('amount');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get(`/procurement/rfqs/${rfq.id}/quotes/${quote.id}`)
      .then((r) => {
        if (!alive) return;
        const q = r.data?.data || {};
        setMeta({ vendor_name: q.vendor_name, line_count: q.line_count, line_unit: q.line_unit, rfq_number: q.rfq_number,
                  is_new: q.unit_price == null && q.total_amount == null });
        setForm(Object.fromEntries(FIELDS.map((k) => [k, blankToEmpty(q[k])])));
        setFreightBasis(q.freight_per_unit != null && q.freight_amount == null ? 'per_unit' : 'amount');
      })
      .catch((e) => alive && setError({ text: e.response?.data?.error || 'Could not load this quote.' }));
    return () => { alive = false; };
  }, [rfq.id, quote.id]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const multiLine = (meta?.line_count ?? 0) > 1;

  const save = async () => {
    setError(null);
    // One freight basis only: clear the field the user is not using.
    const body = { ...form };
    if (freightBasis === 'amount') body.freight_per_unit = '';
    else body.freight_amount = '';
    if (body.shipping_weight_kg_per_unit !== '' && !body.shipping_weight_uom) body.shipping_weight_uom = meta?.line_unit || '';
    setSaving(true);
    try {
      await api.put(`/procurement/rfqs/${rfq.id}/quotes/${quote.id}`, body);
      onSaved?.();
    } catch (e) {
      setError({ text: e.response?.data?.error || 'The quote could not be saved.', field: e.response?.data?.field });
    } finally {
      setSaving(false);
    }
  };

  const F = (k, label, props = {}) => (
    <label style={lbl}>{label}
      <input aria-label={label} style={{ ...inp, borderColor: error?.field === k ? '#dc2626' : '#d1d5db' }}
        value={form[k]} onChange={set(k)} {...props} />
    </label>
  );

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="qe-title">
      <div style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="qe-title" style={{ margin: 0, fontSize: 17 }}>
            {meta?.is_new ? 'Enter quote' : 'Edit quote'} — {meta?.vendor_name || quote.vendor_name} · {meta?.rfq_number || rfq.rfq_number}
          </h2>
          <button aria-label="Close quote entry" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </div>

        {error && (
          <div role="alert" style={{ marginTop: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13, background: '#fef2f2', color: '#991b1b' }}>
            {error.text}
          </div>
        )}

        {!form ? (
          !error && <p style={{ color: '#6b7280', fontSize: 13 }}>Loading the stored quote…</p>
        ) : (
          <>
            <div style={h}>Price</div>
            <div style={grid}>
              {F('unit_price', 'Unit price', { type: 'number', min: 0, step: 'any' })}
              {F('total_amount', 'Total amount', { type: 'number', min: 0, step: 'any' })}
              {F('currency', 'Currency', { maxLength: 3, placeholder: 'INR' })}
              {F('delivery_days', 'Delivery (days)', { type: 'number', min: 0, step: 1 })}
              {F('payment_terms', 'Payment terms', { placeholder: 'e.g. 2/10 net 30' })}
              {F('valid_until', 'Valid until', { type: 'date' })}
              {F('vendor_quote_ref', 'Vendor quotation ref', { maxLength: 80 })}
              {F('quote_date', 'Quotation date', { type: 'date' })}
              {F('tax_pct', 'Tax %', { type: 'number', min: 0, max: 100, step: 'any' })}
            </div>

            <div style={h}>Freight &amp; charges (as the vendor quoted them)</div>
            <div role="radiogroup" aria-label="Freight basis" style={{ display: 'flex', gap: 16, fontSize: 12.5, marginBottom: 8 }}>
              <label><input type="radio" name="qe-freight" checked={freightBasis === 'amount'}
                onChange={() => setFreightBasis('amount')} /> Quote freight as an amount for the consignment</label>
              <label><input type="radio" name="qe-freight" checked={freightBasis === 'per_unit'}
                onChange={() => setFreightBasis('per_unit')} /> Quote freight as a rate per unit</label>
            </div>
            <div style={grid}>
              {freightBasis === 'amount'
                ? F('freight_amount', 'Freight amount', { type: 'number', min: 0, step: 'any', placeholder: 'Not quoted' })
                : F('freight_per_unit', 'Freight per unit', { type: 'number', min: 0, step: 'any', placeholder: 'Not quoted' })}
              {F('freight_currency', 'Freight currency', { maxLength: 3, placeholder: form.currency || 'same as quote' })}
              {F('insurance_amount', 'Insurance', { type: 'number', min: 0, step: 'any', placeholder: 'Not quoted' })}
              {F('duty_amount', 'Duty', { type: 'number', min: 0, step: 'any', placeholder: 'Not quoted' })}
              {F('packaging_amount', 'Packaging', { type: 'number', min: 0, step: 'any', placeholder: 'Not quoted' })}
              {F('other_charges', 'Other charges', { type: 'number', min: 0, step: 'any', placeholder: 'Not quoted' })}
            </div>
            <p style={{ fontSize: 11.5, color: '#6b7280', margin: '6px 0 0' }}>
              Leave a charge blank if the vendor did not quote it — blank is “not quoted”, not zero. Freight entered here is
              <strong> quoted</strong> freight and always takes precedence over modelled (weight × distance) freight.
            </p>

            <div style={h}>Shipping</div>
            <div style={grid}>
              {F('shipping_weight_kg_per_unit', 'Quoted weight (kg per unit)', {
                type: 'number', min: 0, step: 'any', disabled: multiLine,
                placeholder: multiLine ? 'Multi-line RFQ: item weights are used' : 'Not quoted',
              })}
              {F('shipping_weight_uom', 'Weight is per (unit)', { disabled: multiLine, placeholder: meta?.line_unit || 'NOS' })}
              <label style={lbl}>Transport mode
                <select aria-label="Transport mode" style={inp} value={form.transport_mode} onChange={set('transport_mode')}>
                  <option value="">Not stated (lane default)</option>
                  {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label style={lbl}>Service level
                <select aria-label="Service level" style={inp} value={form.service_level} onChange={set('service_level')}>
                  <option value="">Any</option>
                  {SERVICE_LEVELS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              {F('moq', 'MOQ', { type: 'number', min: 0, step: 'any' })}
              {F('warranty_months', 'Warranty (months)', { type: 'number', min: 0, step: 1 })}
            </div>

            <label style={{ ...lbl, marginTop: 12 }}>Notes
              <textarea aria-label="Notes" rows={2} style={inp} value={form.notes} onChange={set('notes')} />
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}>Cancel</button>
              <button onClick={save} disabled={saving}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#6B3FDB', color: '#fff', fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Saving…' : 'Save quote'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
