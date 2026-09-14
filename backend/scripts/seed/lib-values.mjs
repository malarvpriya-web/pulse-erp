// Realistic-value generation for the empty-table seeder.
import crypto from 'crypto';

export const COMPANY_ID = 1;
export const TAG = 'SEED';               // marker so seeded rows are identifiable
const today = new Date('2026-08-20T10:00:00Z');

let seq = 0;
export const nextSeq = () => ++seq;

const pick = (a, i) => a[i % a.length];
const pad = (n, w = 4) => String(n).padStart(w, '0');

const FIRST = ['Arun', 'Priya', 'Vikram', 'Meera', 'Rahul', 'Divya', 'Sanjay', 'Kavita', 'Rohit', 'Anita', 'Karthik', 'Sneha'];
const LAST = ['Sharma', 'Iyer', 'Nair', 'Reddy', 'Menon', 'Gupta', 'Patel', 'Rao', 'Krishnan', 'Verma'];
const ORGS = ['Aurora Systems', 'Vertex Industries', 'Nimbus Controls', 'Sterling Automation', 'Cobalt Energy',
  'Helios Power', 'Zenith Instruments', 'Orbit Fabrication', 'Delta Switchgear', 'Prime Metals'];
const CITY = ['Chennai', 'Bengaluru', 'Pune', 'Hyderabad', 'Coimbatore', 'Mumbai', 'Delhi', 'Ahmedabad'];
const ITEM = ['Control Panel', 'Busbar Assembly', 'Relay Module', 'Cable Harness', 'Transformer Core',
  'Circuit Breaker', 'Terminal Block', 'Sensor Array', 'Cooling Fan', 'Enclosure Frame'];
const DEPT = ['Production', 'Quality', 'Engineering', 'Procurement', 'Finance', 'HR', 'Service', 'Projects'];
const SENT = [
  'Reviewed and found acceptable against the agreed specification.',
  'Pending confirmation from the site team before closure.',
  'Completed on schedule with no deviations recorded.',
  'Minor observation logged; corrective action assigned to the owner.',
  'Verified against the reference document and approved for release.',
];

export function isoDate(d) { return d.toISOString().slice(0, 10); }
export function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

// ── check-constraint interpretation ──────────────────────────────────────────
// Turns `((status)::text = ANY ((ARRAY['a'::varchar, ...])::text[]))` and
// `((score >= 0) AND (score <= 10))` into usable generation hints.
export function parseChecks(checks) {
  const allowed = new Map();   // col -> [literals]
  const range = new Map();     // col -> {min,max}
  const multi = [];            // constraints spanning >1 column (handled on retry)
  const LIT = /'((?:[^']|'')*)'/g;
  for (const c of checks) {
    const cols = c.cols || [];
    const def = c.def;
    if (cols.length === 1) {
      const col = cols[0];
      const anyM = /=\s*ANY\s*\(\s*\(?ARRAY\[([\s\S]+?)\]/.exec(def);
      if (anyM) {
        const lits = [...anyM[1].matchAll(LIT)].map(m => m[1].replace(/''/g, "'"));
        if (lits.length) { allowed.set(col, lits); continue; }
      }
      const inM = /\bIN\s*\(([^)]+)\)/.exec(def);
      if (inM && inM[1].includes("'")) {
        const lits = [...inM[1].matchAll(LIT)].map(m => m[1].replace(/''/g, "'"));
        if (lits.length) { allowed.set(col, lits); continue; }
      }
      const geM = /([a-z_]+)\s*>=\s*\(?(-?[\d.]+)/.exec(def);
      const leM = /([a-z_]+)\s*<=\s*\(?(-?[\d.]+)/.exec(def);
      const gtM = /([a-z_]+)\s*>\s*\(?(-?[\d.]+)/.exec(def);
      if (geM || leM || gtM) {
        range.set(col, {
          min: geM ? Number(geM[2]) : (gtM ? Number(gtM[2]) + 1 : null),
          max: leM ? Number(leM[2]) : null,
        });
      }
    } else if (cols.length > 1) {
      multi.push({ name: c.conname, cols, def });
    }
  }
  return { allowed, range, multi };
}

// ── per-column value generation ──────────────────────────────────────────────
export function genValue(col, ctx) {
  const { table, idx, hints, enumMap, rowSeq } = ctx;
  const name = col.column_name;
  const n = name.toLowerCase();
  const type = col.data_type;
  const udt = col.udt_name;
  const maxLen = col.character_maximum_length;
  const uniq = ctx.uniqueCols.has(name);
  const tail = uniq ? `-${TAG}${pad(rowSeq, 5)}` : '';

  // 1. constrained vocabularies win over everything
  const allowed = hints.allowed.get(name);
  if (allowed) return pick(allowed, idx);
  if (udt && enumMap.has(udt)) return pick(enumMap.get(udt), idx);

  const rng = hints.range.get(name);
  const clampNum = (v) => {
    if (!rng) return v;
    let x = v;
    if (rng.min != null && x < rng.min) x = rng.min;
    if (rng.max != null && x > rng.max) x = rng.max;
    return x;
  };
  const str = (v) => (maxLen && v.length > maxLen ? v.slice(0, maxLen) : v);

  // 2. structural types
  if (type === 'ARRAY') return arrayFor(col, idx);
  if (udt === 'jsonb' || udt === 'json') return jsonFor(n, idx);
  if (udt === 'uuid') return crypto.randomUUID();
  if (udt === 'inet' || udt === 'cidr') return `10.0.${idx % 250}.${(idx * 7) % 250}`;
  if (udt === 'bytea') return null;
  if (udt === 'interval') return `${1 + idx} days`;
  if (type === 'boolean') return boolFor(n, idx);
  if (type.startsWith('time with') || type.startsWith('time without')) {
    return /(out|end|close)/.test(n) ? '18:30:00' : '09:30:00';
  }
  if (type === 'date') return isoDate(dateFor(n, idx));
  if (type.startsWith('timestamp')) return dateFor(n, idx).toISOString();

  // 3. numerics
  if (['integer', 'bigint', 'smallint'].includes(type)) return clampNum(intFor(n, idx, rng));
  if (['numeric', 'real', 'double precision', 'money'].includes(type)) {
    let v = clampNum(numFor(n, idx, rng));
    const p = col.numeric_precision, s = col.numeric_scale;
    if (p != null && s != null) {                       // respect numeric(p,s) width
      const cap = Math.pow(10, p - s) - 1;
      if (v > cap) v = Math.floor(cap * 0.9);
      v = Number(v.toFixed(s));
    }
    return v;
  }

  // 4. strings, by column-name intent
  return str(textFor(n, idx, rowSeq, table) + tail);
}

function boolFor(n, i) {
  if (/(is_active|active|enabled|is_enabled|visible)/.test(n)) return true;
  if (/(deleted|archived|locked|blocked|cancelled|failed)/.test(n)) return false;
  return i % 2 === 0;
}

function dateFor(n, i) {
  if (/(dob|birth)/.test(n)) return new Date(Date.UTC(1990 + (i % 10), i % 12, 1 + (i % 27)));
  if (/(start|from|issue|order|created|applied|posted|opened|joining|effective)/.test(n)) {
    return addDays(today, -60 + i * 3);
  }
  if (/(end|to_date|valid_to|expiry|expires|due|target|closed|completion|renewal|next_)/.test(n)) {
    return addDays(today, 30 + i * 5);
  }
  return addDays(today, -10 + i);
}

function intFor(n, i, rng) {
  if (/year/.test(n)) return 2026;
  if (/month/.test(n)) return 1 + (i % 12);
  if (/(day|days)/.test(n)) return 1 + (i % 28);
  if (/(_id|_by)$/.test(n)) return 1 + (i % 5);
  if (/(qty|quantity|count|units|nos)/.test(n)) return 5 + i * 3;
  // A rating is a 1-5 star scale, not a percentage — seeding 60 into one made
  // CAPAManagement crash on '☆'.repeat(5 - rating). NPS is 0-10.
  if (/rating/.test(n)) return 1 + (i % 5);
  if (/nps/.test(n)) return 1 + (i % 10);
  if (PCT_RATE(n)) return Math.min(100, 12 + (i % 7) * 9);
  if (/(percent|pct|percentage|score|utilization)/.test(n)) return Math.min(100, 60 + i * 5);
  if (/(sequence|order_no|sort|priority|level|version|attempt|revision)/.test(n)) return 1 + i;
  if (/(hours|hrs)/.test(n)) return 4 + i;
  if (/(amount|price|cost|value|total|salary|budget)/.test(n)) return 25000 + i * 7500;
  if (rng && rng.max != null) return Math.min(rng.max, (rng.min ?? 0) + i);
  return 1 + i;
}

// A `_rate` column is a price in some tables and a proportion in others.
// `win_rate` matched the money branch below, produced 1250.5, and the
// numeric(5,2) width cap floored that to `Math.floor(999 * 0.9)` = **899** —
// which then rendered as "899% win rate". These names are proportions; the
// money senses (unit/hourly/daily/bill/exchange/freight rates) are not.
// ISO 4217 codes, so a 3-char `currency_code` column stays a currency code.
const ISO_CCY = ['USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'AUD', 'CHF'];
// Index-aligned with ISO_CCY: a row whose code says USD must not have a name
// saying INR — that pairing is what made the seeded forex rows read as
// "one rupee is worth 1250 rupees".
const CCY_NAME = ['US Dollar', 'Euro', 'Pound Sterling', 'UAE Dirham',
                  'Singapore Dollar', 'Japanese Yen', 'Australian Dollar', 'Swiss Franc'];
// Plausible units of INR per unit of the above, index-aligned.
const FX_VS_INR = [83.20, 90.10, 105.40, 22.65, 61.80, 0.56, 54.30, 94.70];

// Performance/quality proportions expressed as a percentage.
const PROPORTION_RATE = /(^|_)(win|loss|conversion|success|failure|defect|reject|scrap|rework|attrition|turnover|retention|churn|completion|utilisation|utilization|occupancy|adoption|response|resolution|growth|on_time|first_pass|fill|pass|yield|error|accuracy|availability|uptime|absent|absenteeism|open|click|bounce)_rate(_|$)/;

// Statutory and commercial rates. Every one of these is a percentage of a
// taxable/base amount, never a per-unit price — and the whole tax family was
// landing in the money branch, so `master_hsn_sac.gst_rate` (the GST master
// itself) held 899 in every seeded row.
const CHARGE_RATE = /(^|_)(gst|cgst|sgst|igst|utgst|cess|vat|tax|tds|tcs|duty|wdv|depreciation|deduction|commission|discount|markup|margin|interest|penalty|surcharge)_rate(_|$)/;

// `rate_with_pan` / `rate_without_pan` (TDS/TCS masters) and any `*_rate_pct`.
const NAMED_PCT_RATE = /^rate_(with|without)_pan$|^rate_pct$|_rate_pct$/;

const PCT_RATE = (n) => PROPORTION_RATE.test(n) || CHARGE_RATE.test(n) || NAMED_PCT_RATE.test(n);

function numFor(n, i, rng) {
  // An FX rate is neither a percentage nor a unit price. `exchange_rate` and
  // `rate_vs_inr` matched the money branch and were seeded at 1250.5 — against
  // a currency_name of 'INR', so every seeded row asserted that one rupee was
  // worth 1250 rupees.
  if (/(exchange_rate|rate_vs_inr|fx_rate|forex_rate)/.test(n)) return FX_VS_INR[i % FX_VS_INR.length];
  if (PCT_RATE(n)) return Number((12 + (i % 7) * 9.5).toFixed(2));
  if (/(percent|pct|percentage|utilization|efficiency|progress)/.test(n)) return Number(Math.min(100, 55 + i * 6.5).toFixed(2));
  if (/(rating|score|cpi|spi)/.test(n)) return Number((3.5 + (i % 3) * 0.4).toFixed(2));
  if (/(qty|quantity|weight|volume|hours|hrs)/.test(n)) return Number((10 + i * 2.5).toFixed(2));
  if (/(tax|gst|cgst|sgst|igst|tds|tcs)/.test(n)) return Number((1800 + i * 450).toFixed(2));
  if (/(rate|unit_price|price)/.test(n)) return Number((1250.5 + i * 175).toFixed(2));
  if (/(lat|latitude)/.test(n)) return Number((13.0827 + i * 0.01).toFixed(6));
  if (/(lng|long|longitude)/.test(n)) return Number((80.2707 + i * 0.01).toFixed(6));
  if (/(amount|cost|value|total|salary|budget|revenue|expense|balance|limit)/.test(n)) {
    return Number((125000 + i * 37500).toFixed(2));
  }
  if (rng && rng.max != null) return Math.min(rng.max, (rng.min ?? 0) + i);
  return Number((100 + i * 25).toFixed(2));
}

function arrayFor(col, i) {
  const el = col.udt_name.replace(/^_/, '');
  if (['int4', 'int8', 'int2', 'numeric'].includes(el)) return [1 + i, 2 + i];
  if (el === 'uuid') return [crypto.randomUUID()];
  return [`${TAG}-tag-${i + 1}`, pick(DEPT, i)];
}

// json/jsonb shape matters: a UI that does `value.map(...)` throws on an object,
// so anything that reads as a collection has to come back as an array.
function jsonFor(n, i) {
  if (/(weekly_off|week_off|off_days)/.test(n)) return JSON.stringify(['sunday']);
  if (/(department|dept)s?$/.test(n)) return JSON.stringify([pick(DEPT, i)]);
  if (/(config|settings|options|params|preference)/.test(n)) return JSON.stringify({ enabled: true, threshold: 10 + i });
  if (/(filter|criteria|condition)s?$/.test(n)) return JSON.stringify({ field: 'status', op: 'eq', value: 'active' });
  if (/(payload|body|response|request|meta|metadata)$/.test(n)) {
    return JSON.stringify({ source: TAG, index: i, note: 'generated fixture' });
  }
  if (/(tags|recipients|roles|permissions|emails|labels|categories|attachments|files|photos|values|codes)$/.test(n)) {
    return JSON.stringify([`${TAG}-${i + 1}`]);
  }
  if (/(items|lines|steps|entries|records|rows|details|results|readings|changes|history)$/.test(n)) {
    return JSON.stringify([{ seq: 1, label: pick(ITEM, i) }]);
  }
  if (/s$/.test(n) && !/(status|address|progress|analysis|notes|remarks)$/.test(n)) {
    return JSON.stringify([`${TAG}-${i + 1}`]);          // plural name ⇒ collection
  }
  return JSON.stringify({ seed: TAG, i });
}

function textFor(n, i, rowSeq, table) {
  const org = pick(ORGS, i), who = `${pick(FIRST, i)} ${pick(LAST, i + 3)}`;
  const abbr = table.split('_').map(w => w[0]).join('').toUpperCase().slice(0, 4) || 'GEN';

  // clock times and colours are frequently varchar rather than time/typed columns
  if (/(_time$|^time$|shift_start|shift_end|clock_in|clock_out)/.test(n)) {
    return /(out|end|close)/.test(n) ? '18:00' : '09:30';
  }
  if (/colou?r/.test(n)) return pick(['#6B3FDB', '#2563eb', '#059669', '#d97706', '#dc2626'], i);

  if (/(^|_)email$/.test(n) || /email_address/.test(n)) return `${TAG.toLowerCase()}${rowSeq}@manifest.in`;
  if (/(phone|mobile|contact_no|telephone)/.test(n)) return `98${pad(40000000 + rowSeq, 8)}`;
  if (/(gstin|gst_no)/.test(n)) return `33AABCU${pad(9000 + i, 4)}A1Z5`;
  if (/^pan/.test(n)) return `AABCU${pad(9000 + i, 4)}A`;
  if (/ifsc/.test(n)) return 'HDFC0001234';
  if (/(account_number|bank_account)/.test(n)) return `50100${pad(100000 + rowSeq, 8)}`;
  // Currency must be classified before the generic `_code$` branch below, or
  // `currency_code` comes out as an abbreviation truncated to the column's
  // 3 characters — which is how forex_rates ended up keyed on 'FR-' and '944'.
  // A bare `currency` column is the transaction currency and stays INR (the
  // base); a code/name pair describes some *other* currency and must agree.
  if (/currency/.test(n)) {
    if (/(code|iso)/.test(n)) return pick(ISO_CCY, i);
    if (/name/.test(n))       return pick(CCY_NAME, i);
    return 'INR';
  }
  if (/(_number$|_code$|_no$|^code$|^number$|^ref$|^reference$|serial|voucher|invoice_no)/.test(n)) {
    return `${abbr}-${pad(1000 + rowSeq, 5)}`;
  }
  if (/(url|link|endpoint|webhook|website)/.test(n)) return `https://example.invalid/${TAG.toLowerCase()}/${rowSeq}`;
  if (/priority/.test(n)) return pick(['Low', 'Medium', 'High', 'Critical'], i);
  if (/severity/.test(n)) return pick(['Minor', 'Major', 'Critical'], i);
  if (/(path|file_url|attachment)/.test(n)) return `/uploads/${TAG.toLowerCase()}/doc-${rowSeq}.pdf`;
  if (/(file_name|filename)/.test(n)) return `${TAG}-document-${rowSeq}.pdf`;
  if (/(mime|content_type)/.test(n)) return 'application/pdf';
  if (/(uom|^unit$|unit_of)/.test(n)) return pick(['Nos', 'Kg', 'Mtr', 'Set'], i);
  if (/city/.test(n)) return pick(CITY, i);
  if (/state$/.test(n)) return 'Tamil Nadu';
  if (/country/.test(n)) return 'India';
  if (/(pincode|postal|zip)/.test(n)) return `6000${pad(i % 100, 2)}`;
  if (/(address|location|site|venue|premises)/.test(n)) return `${12 + i} ${pick(CITY, i)} Industrial Estate`;
  if (/(department|dept)/.test(n)) return pick(DEPT, i);
  if (/(designation|job_title)/.test(n)) return pick(['Engineer', 'Senior Engineer', 'Manager', 'Lead'], i);
  if (/first_name/.test(n)) return pick(FIRST, i);
  if (/(last_name|surname)/.test(n)) return pick(LAST, i);
  if (/(full_name|employee_name|person|contact_name|owner_name|approver_name)/.test(n)) return who;
  if (/(customer_name|client_name|party_name|vendor_name|supplier_name|company_name|organization)/.test(n)) return org;
  if (/(item_name|product_name|material|component)/.test(n)) return pick(ITEM, i);
  if (/(description|remarks|comments|notes|summary|reason|justification|feedback|message|body|content)/.test(n)) {
    return pick(SENT, i);
  }
  if (/(^title$|^subject$|^name$|_name$|^label$|^heading$)/.test(n)) {
    return `${TAG} ${table.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} ${i + 1}`;
  }
  if (/(status|state)$/.test(n)) return 'active';
  if (/(type|category|kind|mode|method|channel|source|priority|severity)/.test(n)) {
    return pick(['Standard', 'General', 'Primary', 'Routine'], i);
  }
  if (/(hash|token|key|secret)/.test(n)) return crypto.randomBytes(12).toString('hex');
  if (/version/.test(n)) return `v1.${i}`;
  return `${TAG} ${n.replace(/_/g, ' ')} ${i + 1}`;
}
