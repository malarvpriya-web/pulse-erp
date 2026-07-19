/**
 * GST auto-detection and calculation for India.
 *
 * Intra-state (same state): CGST 9% + SGST 9% = 18% total
 * Inter-state (different states): IGST 18%
 */

// GSTIN first-two-digit state code → state name (as per Schedule to CGST Rules)
const GSTIN_STATE = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman & Diu',
  '26': 'Dadra & Nagar Haveli',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar',
  '36': 'Telangana',
  '37': 'Andhra Pradesh (new)',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

// Manifest Technologies is registered in Karnataka (GSTIN prefix '29')
const COMPANY_STATE = 'Karnataka';

/**
 * Resolve state name from a 15-character GSTIN.
 * @param {string} gstin
 * @returns {string|null}
 */
function getStateFromGSTIN(gstin) {
  const prefix = (gstin || '').substring(0, 2);
  return GSTIN_STATE[prefix] || null;
}

/**
 * Auto-detect GST type from a counterparty GSTIN.
 * Compares the GSTIN state prefix against the company state (Karnataka / '29').
 * @param {string} counterpartyGSTIN
 * @returns {'CGST_SGST'|'IGST'}
 */
function detectGSTFromGSTIN(counterpartyGSTIN) {
  const counterpartyState = getStateFromGSTIN(counterpartyGSTIN);
  if (!counterpartyState) return 'IGST';
  return detectGSTType(COMPANY_STATE, counterpartyState);
}

/**
 * Auto-detect GST type from a counterparty state name (compared to the company
 * state, Karnataka). Falls back to intra-state (CGST_SGST) when state is unknown.
 * @param {string} counterpartyState
 * @returns {'CGST_SGST'|'IGST'}
 */
function detectGSTFromState(counterpartyState) {
  if (!counterpartyState) return 'CGST_SGST';
  return detectGSTType(COMPANY_STATE, counterpartyState);
}

/**
 * Determine GST type from company and customer/vendor state names.
 * @param {string} companyState
 * @param {string} counterpartyState
 * @returns {'CGST_SGST'|'IGST'}
 */
function detectGSTType(companyState, counterpartyState) {
  const normalize = (s) => (s || '').toLowerCase().trim();
  if (normalize(companyState) === normalize(counterpartyState)) {
    return 'CGST_SGST';
  }
  return 'IGST';
}

/**
 * Calculate GST amounts from a taxable base amount.
 * @param {number} amount    - taxable base (before GST)
 * @param {number} rate      - GST rate percent (e.g. 18)
 * @param {'CGST_SGST'|'IGST'} gstType
 * @returns {{ cgst: number, sgst: number, igst: number, total: number }}
 */
function calculateGST(amount, rate, gstType) {
  const total = amount * (rate / 100);
  if (gstType === 'CGST_SGST') {
    return { cgst: total / 2, sgst: total / 2, igst: 0, total };
  }
  return { cgst: 0, sgst: 0, igst: total, total };
}

/**
 * GSTIN format validation — 15 chars: 2-digit state code, 10-char PAN, 1-char
 * entity number, literal 'Z', 1-char checksum.
 *
 * Mirrors frontend utils/gstinValidation.js character-for-character, and is the
 * server-side half that did not exist before: the frontend validator was the ONLY
 * GSTIN format check in the system, so any caller reaching the API directly could
 * store arbitrary text in a gstin column.
 *
 * NOT state-restricted by design. Manifest is Karnataka-registered ('29'), but a
 * counterparty may be based in any state — detectGSTFromGSTIN() already derives
 * intra- vs inter-state from the prefix, so pinning the prefix here would break
 * every inter-state party. Returning stateName lets callers derive State from the
 * GSTIN instead of asking the user to type it twice.
 *
 * @param {string} gstin
 * @returns {{valid: boolean, error?: string, stateCode?: string, stateName?: string, pan?: string}}
 */
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
function validateGSTIN(gstin) {
  if (!gstin || !String(gstin).trim()) return { valid: false, error: 'GSTIN is required' };
  const clean = String(gstin).trim().toUpperCase();
  if (!GSTIN_REGEX.test(clean)) {
    return { valid: false, error: 'Invalid GSTIN format (e.g. 29AAAAA0000A1Z5)' };
  }
  const stateCode = clean.substring(0, 2);
  if (!GSTIN_STATE[stateCode]) return { valid: false, error: `Invalid GSTIN state code: ${stateCode}` };
  return {
    valid: true,
    stateCode,
    stateName: GSTIN_STATE[stateCode],
    pan: clean.substring(2, 12),
  };
}

/**
 * PAN format validation — 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).
 * @param {string} pan
 * @returns {boolean}
 */
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
function validatePAN(pan) {
  return typeof pan === 'string' && PAN_REGEX.test(pan.trim().toUpperCase());
}

/**
 * Validate that a GST head split is internally consistent for Indian GST:
 *  - Intra-state supply uses CGST + SGST (equal halves), no IGST.
 *  - Inter-state supply uses IGST only, no CGST/SGST.
 * Prevents client-side misclassification from producing non-compliant filings.
 * @param {{cgst?:number, sgst?:number, igst?:number}} split
 * @returns {{valid: boolean, error?: string}}
 */
function validateGstSplit({ cgst = 0, sgst = 0, igst = 0 } = {}) {
  const c = parseFloat(cgst) || 0;
  const s = parseFloat(sgst) || 0;
  const i = parseFloat(igst) || 0;
  if (i > 0 && (c > 0 || s > 0)) {
    return { valid: false, error: 'Invalid GST split: IGST cannot be combined with CGST/SGST on the same document.' };
  }
  if ((c > 0 || s > 0) && Math.abs(c - s) > 0.01) {
    return { valid: false, error: 'Invalid GST split: CGST and SGST must be equal for intra-state supply.' };
  }
  return { valid: true };
}

export { GSTIN_STATE, getStateFromGSTIN, detectGSTFromGSTIN, detectGSTFromState, detectGSTType, calculateGST, validateGSTIN, GSTIN_REGEX, validatePAN, PAN_REGEX, validateGstSplit, COMPANY_STATE };
