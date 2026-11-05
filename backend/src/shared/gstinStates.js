/**
 * GSTIN first 2 digits → Indian state name (GST state codes).
 * Shared by Company Profile (state derivation and the GSTIN/state check) and
 * the payroll release gate (COMPANY_GSTIN_STATE). Pure data — no DB access,
 * so importing it never runs a router's import-time DDL.
 */
export const GSTIN_STATE_CODES = {
  '01': 'Jammu & Kashmir',   '02': 'Himachal Pradesh',  '03': 'Punjab',
  '04': 'Chandigarh',        '05': 'Uttarakhand',        '06': 'Haryana',
  '07': 'Delhi',              '08': 'Rajasthan',          '09': 'Uttar Pradesh',
  '10': 'Bihar',              '11': 'Sikkim',             '12': 'Arunachal Pradesh',
  '13': 'Nagaland',           '14': 'Manipur',            '15': 'Mizoram',
  '16': 'Tripura',            '17': 'Meghalaya',          '18': 'Assam',
  '19': 'West Bengal',        '20': 'Jharkhand',          '21': 'Odisha',
  '22': 'Chhattisgarh',       '23': 'Madhya Pradesh',     '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',        '28': 'Andhra Pradesh',     '29': 'Karnataka',
  '30': 'Goa',                '31': 'Lakshadweep',        '32': 'Kerala',
  '33': 'Tamil Nadu',         '34': 'Puducherry',         '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',          '37': 'Andhra Pradesh (New)',
};

/** State a GSTIN is registered in, or null. */
export function stateFromGstin(gstin) {
  const g = String(gstin || '').trim().toUpperCase();
  return g.length >= 2 ? (GSTIN_STATE_CODES[g.slice(0, 2)] ?? null) : null;
}
