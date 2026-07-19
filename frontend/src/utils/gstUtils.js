/**
 * gstUtils.js — GST type detection and GSTIN validation for Manifest Technologies.
 *
 * Manifest Technologies is in Bangalore, Karnataka (state code 29).
 * CGST + SGST applies for intra-state (both parties in Karnataka).
 * IGST applies for inter-state or B2C (unregistered/missing GSTIN).
 */

const COMPANY_STATE_CODE = '29'; // Karnataka

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Returns 'CGST_SGST' for intra-state registered dealers,
 * 'IGST' for inter-state or unregistered/B2C.
 *
 * @param {string|null} customerGSTIN - customer's GSTIN (null/empty = B2C)
 * @param {string} [companyStateCode] - company's 2-digit state code (default: '29' Karnataka)
 * @returns {'CGST_SGST'|'IGST'}
 */
export const getGSTType = (customerGSTIN, companyStateCode = COMPANY_STATE_CODE) => {
  if (!customerGSTIN || customerGSTIN.trim().length < 2) return 'IGST'; // B2C unregistered
  const customerStateCode = customerGSTIN.trim().substring(0, 2);
  return customerStateCode === companyStateCode ? 'CGST_SGST' : 'IGST';
};

/**
 * Validates GSTIN format.
 * @param {string} gstin
 * @returns {boolean}
 */
export const validateGSTIN = (gstin) => {
  if (!gstin) return false;
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
};

/**
 * Returns the 2-digit state code from a GSTIN.
 * @param {string} gstin
 * @returns {string} e.g. '29'
 */
export const getStateCodeFromGSTIN = (gstin) => {
  if (!gstin || gstin.length < 2) return '';
  return gstin.substring(0, 2);
};

/**
 * Given a base amount and GST rate, returns the split amounts.
 * @param {number} baseAmount
 * @param {number} gstRate - percentage e.g. 18
 * @param {'CGST_SGST'|'IGST'} gstType
 * @returns {{ cgst: number, sgst: number, igst: number, total: number }}
 */
export const calcGST = (baseAmount, gstRate, gstType = 'IGST') => {
  const totalTax = +(baseAmount * gstRate / 100).toFixed(2);
  if (gstType === 'CGST_SGST') {
    const half = +(totalTax / 2).toFixed(2);
    return { cgst: half, sgst: half, igst: 0, total: baseAmount + totalTax };
  }
  return { cgst: 0, sgst: 0, igst: totalTax, total: baseAmount + totalTax };
};

export default { getGSTType, validateGSTIN, getStateCodeFromGSTIN, calcGST };
