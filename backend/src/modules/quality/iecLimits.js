/**
 * iecLimits.js — IEC 61000-3-2:2018 Harmonic Current Limits
 *
 * Source: IEC 61000-3-2:2018, Table 2 (Class A) and Table 3 (Class D).
 * All limit values are in Amperes (A rms) for individual harmonic components.
 * These are fixed standard constants — never derived from measurements.
 *
 * Usage:
 *   getHarmonicLimit(3, 'class_a')  // → 2.30
 *   getHarmonicLimit(5, 'class_a')  // → 1.14
 *   getHarmonicLimit(15, 'class_a') // → 0.15 (formula: 0.15 × 15/n)
 */

// IEC 61000-3-2 Table 2 — Class A explicit limits (A rms)
const CLASS_A = {
  2: 1.08,  3: 2.30,  4: 0.43,  5: 1.14,
  6: 0.30,  7: 0.77,  8: 0.23,  9: 0.40,
  10: 0.184, 11: 0.33, 12: 0.153, 13: 0.21,
};

// IEC 61000-3-2 Table 3 — Class D limits (W-referenced, using 600W baseline)
// Expressed as mA/W × 600W for a representative 600 W appliance
const CLASS_D = {
  3: 3.4, 5: 1.9, 7: 1.0, 9: 0.5, 11: 0.35, 13: 0.296,
};

/**
 * Returns the IEC harmonic current limit (A) for a given harmonic order and class.
 * Returns null if the order is out of the standard's scope (< 2 or > 40).
 *
 * Formula rules (IEC 61000-3-2:2018):
 *   Class A odd  15 ≤ n ≤ 39:  0.15 × (15/n)
 *   Class A even 14 ≤ n ≤ 40:  0.23 × (8/n)
 *   Class D odd  15 ≤ n ≤ 39:  0.296 × (13/n)  [approximate extrapolation]
 */
export function getHarmonicLimit(order, complianceClass = 'class_a') {
  const n = parseInt(order);
  if (!Number.isFinite(n) || n < 2 || n > 40) return null;

  if (complianceClass === 'class_a' || complianceClass === 'class_b') {
    // Class B = Class A × 1.5  (IEC 61000-3-2 Note: Class B is Class A × 1.5)
    const mult = complianceClass === 'class_b' ? 1.5 : 1.0;
    if (CLASS_A[n] != null) return +(CLASS_A[n] * mult).toFixed(4);
    if (n % 2 === 1 && n >= 15 && n <= 39) return +(0.15 * (15 / n) * mult).toFixed(4);
    if (n % 2 === 0 && n >= 14 && n <= 40) return +(0.23 * (8  / n) * mult).toFixed(4);
  }

  if (complianceClass === 'class_d') {
    if (CLASS_D[n] != null) return CLASS_D[n];
    if (n % 2 === 1 && n >= 15 && n <= 39) return +(0.296 * (13 / n)).toFixed(4);
    return null;
  }

  // Class C — lighting equipment; limits depend on active power factor, not tabulated here
  return null;
}

/**
 * THD-I and THD-V practical limits used as supplemental checks.
 * IEC 61000-3-2 specifies per-harmonic limits, not a single THD figure.
 * These thresholds are widely used in industrial PQ commissioning specs.
 */
export const THD_I_LIMIT_PERCENT = {
  class_a: 5.0,
  class_b: 8.0,
  class_c: 10.0,
  class_d: 5.0,
};

export const THD_V_LIMIT_PERCENT = {
  class_a: 5.0,
  class_b: 5.0,
  class_c: 5.0,
  class_d: 5.0,
};

export const COMPLIANCE_CLASSES = ['class_a', 'class_b', 'class_c', 'class_d'];

export const COMPLIANCE_CLASS_LABELS = {
  class_a: 'Class A — Balanced 3-phase equipment, household appliances',
  class_b: 'Class B — Portable tools and non-professional arc welding equipment',
  class_c: 'Class C — Lighting equipment',
  class_d: 'Class D — PCs, PC monitors, radio/TV receivers ≤ 600W',
};
