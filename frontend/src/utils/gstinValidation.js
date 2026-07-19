const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export const STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam',
  '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
  '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman & Nicobar', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

export function validateGSTIN(gstin) {
  if (!gstin) return { valid: false, error: 'GSTIN is required' };
  const clean = gstin.trim().toUpperCase();
  if (!GSTIN_REGEX.test(clean)) return { valid: false, error: 'Invalid GSTIN format (e.g. 22AAAAA0000A1Z5)' };
  const stateCode = clean.substring(0, 2);
  if (!STATE_CODES[stateCode]) return { valid: false, error: `Invalid state code: ${stateCode}` };
  return { valid: true, stateCode, stateName: STATE_CODES[stateCode], pan: clean.substring(2, 12) };
}

export function gstinToState(gstin) {
  if (!gstin || gstin.length < 2) return '';
  return STATE_CODES[gstin.substring(0, 2)] || '';
}
