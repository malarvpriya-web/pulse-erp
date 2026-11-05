/**
 * 20260914000002_iot_metric_catalogue.js
 *
 * The supported electrical measurement contract for AHF / SVG / STATCOM, plus the
 * three generic device-profile templates.
 *
 * This is reference/configuration data, not business data: it declares what a
 * metric MEANS (unit, physical range, aggregation rule, whether rising is bad,
 * whether it is a monotonic counter). Before this, "thd_i" was a 40-character
 * string with no unit and no range, so 899 or -12 was as acceptable as 4.2 — the
 * same class of defect as master_hsn_sac.gst_rate holding 899.
 *
 * WHAT IS DELIBERATELY NOT SEEDED:
 *   register_map on the profiles is EMPTY. A register map is specific to a
 *   manufacturer, model and firmware; inventing one would be fabricating hardware
 *   facts. Profiles ship as templates (is_template = TRUE) carrying the capability
 *   list and the decode conventions that must be set per device, and a device
 *   cannot be polled over Modbus until a real map is entered.
 *
 * device_types on a metric is the capability gate: a metric is only offered for a
 * device whose profile declares it. Not every unit exposes every measurement.
 */

const AHF = 'AHF', SVG = 'SVG', ST = 'STATCOM';
const ALL = [AHF, SVG, ST];

// [code, name, unit, min, max, prec, agg, rising_is_bad, is_counter, device_types, description]
const METRICS = [
  // ── Voltage ───────────────────────────────────────────────────────────────
  ['V_L1', 'Voltage L1-N', 'V', 0, 1000, 2, 'avg', false, false, ALL, 'Phase-to-neutral RMS voltage, line 1'],
  ['V_L2', 'Voltage L2-N', 'V', 0, 1000, 2, 'avg', false, false, ALL, 'Phase-to-neutral RMS voltage, line 2'],
  ['V_L3', 'Voltage L3-N', 'V', 0, 1000, 2, 'avg', false, false, ALL, 'Phase-to-neutral RMS voltage, line 3'],
  ['V_L12', 'Voltage L1-L2', 'V', 0, 1732, 2, 'avg', false, false, ALL, 'Line-to-line RMS voltage'],
  ['V_L23', 'Voltage L2-L3', 'V', 0, 1732, 2, 'avg', false, false, ALL, 'Line-to-line RMS voltage'],
  ['V_L31', 'Voltage L3-L1', 'V', 0, 1732, 2, 'avg', false, false, ALL, 'Line-to-line RMS voltage'],
  // ── Current ───────────────────────────────────────────────────────────────
  ['I_L1', 'Current L1', 'A', 0, 10000, 2, 'avg', false, false, ALL, 'RMS line current, line 1'],
  ['I_L2', 'Current L2', 'A', 0, 10000, 2, 'avg', false, false, ALL, 'RMS line current, line 2'],
  ['I_L3', 'Current L3', 'A', 0, 10000, 2, 'avg', false, false, ALL, 'RMS line current, line 3'],
  // ── Frequency ─────────────────────────────────────────────────────────────
  ['FREQUENCY', 'Frequency', 'Hz', 40, 70, 2, 'avg', false, false, ALL, 'Supply frequency'],
  // ── Power ─────────────────────────────────────────────────────────────────
  ['KW', 'Active power', 'kW', -100000, 100000, 3, 'avg', false, false, ALL, 'Signed: positive = import'],
  ['KVAR', 'Reactive power', 'kVAr', -100000, 100000, 3, 'avg', false, false, ALL, 'Signed: positive = inductive (lagging)'],
  ['KVA', 'Apparent power', 'kVA', 0, 100000, 3, 'avg', false, false, ALL, 'Apparent power'],
  // ── Power factor ──────────────────────────────────────────────────────────
  // Sign convention: POSITIVE = lagging (inductive), NEGATIVE = leading (capacitive).
  // Aggregation is NOT a mean of the samples — see ratios.js aggregatePf().
  ['PF', 'True power factor', 'ratio', -1, 1, 4, 'pf_energy', false, false, ALL,
   'True PF. Sign convention: positive = lagging. Aggregated from kWh/kVAh energy, never averaged.'],
  ['PF_DISP', 'Displacement power factor', 'ratio', -1, 1, 4, 'pf_energy', false, false, ALL,
   'cos(phi) of the fundamental only. Differs from true PF whenever THD is non-zero.'],
  // ── Energy (monotonic counters) ───────────────────────────────────────────
  ['ENERGY_KWH', 'Active energy', 'kWh', 0, null, 3, 'counter', false, true, ALL,
   'Monotonic counter. Deltas must be computed with reset/rollover detection.'],
  ['ENERGY_KVARH', 'Reactive energy', 'kVArh', 0, null, 3, 'counter', false, true, ALL,
   'Monotonic counter. Deltas must be computed with reset/rollover detection.'],
  ['ENERGY_KVAH', 'Apparent energy', 'kVAh', 0, null, 3, 'counter', false, true, ALL,
   'Monotonic counter. Denominator of energy-weighted true PF.'],
  // ── Harmonic distortion ───────────────────────────────────────────────────
  ['THD_V_L1', 'Voltage THD L1', '%', 0, 100, 3, 'avg', true, false, ALL, 'Total harmonic distortion of voltage'],
  ['THD_V_L2', 'Voltage THD L2', '%', 0, 100, 3, 'avg', true, false, ALL, 'Total harmonic distortion of voltage'],
  ['THD_V_L3', 'Voltage THD L3', '%', 0, 100, 3, 'avg', true, false, ALL, 'Total harmonic distortion of voltage'],
  ['THD_I_L1', 'Current THD L1', '%', 0, 500, 3, 'avg', true, false, ALL, 'Total harmonic distortion of current'],
  ['THD_I_L2', 'Current THD L2', '%', 0, 500, 3, 'avg', true, false, ALL, 'Total harmonic distortion of current'],
  ['THD_I_L3', 'Current THD L3', '%', 0, 500, 3, 'avg', true, false, ALL, 'Total harmonic distortion of current'],
  ['HARMONIC_03', '3rd harmonic', '%', 0, 100, 3, 'avg', true, false, ALL, 'Individual harmonic magnitude, % of fundamental'],
  ['HARMONIC_05', '5th harmonic', '%', 0, 100, 3, 'avg', true, false, ALL, 'Individual harmonic magnitude, % of fundamental'],
  ['HARMONIC_07', '7th harmonic', '%', 0, 100, 3, 'avg', true, false, ALL, 'Individual harmonic magnitude, % of fundamental'],
  ['HARMONIC_09', '9th harmonic', '%', 0, 100, 3, 'avg', true, false, ALL, 'Individual harmonic magnitude, % of fundamental'],
  ['HARMONIC_11', '11th harmonic', '%', 0, 100, 3, 'avg', true, false, ALL, 'Individual harmonic magnitude, % of fundamental'],
  ['HARMONIC_13', '13th harmonic', '%', 0, 100, 3, 'avg', true, false, ALL, 'Individual harmonic magnitude, % of fundamental'],
  // ── Balance ───────────────────────────────────────────────────────────────
  ['V_UNBALANCE', 'Voltage unbalance', '%', 0, 100, 3, 'avg', true, false, ALL, 'Max deviation from the three-phase mean, as a percentage'],
  ['I_UNBALANCE', 'Current unbalance', '%', 0, 100, 3, 'avg', true, false, ALL, 'Max deviation from the three-phase mean, as a percentage'],
  // ── Compensation (what these units are FOR) ───────────────────────────────
  ['COMP_CURRENT', 'Compensation current', 'A', 0, 10000, 2, 'avg', false, false, ALL, 'Current the unit is injecting'],
  ['COMP_REACTIVE', 'Reactive compensation', 'kVAr', -100000, 100000, 3, 'avg', false, false, [SVG, ST], 'Reactive power the unit is supplying'],
  ['LOADING_PCT', 'Output utilisation', '%', 0, 150, 2, 'avg', true, false, ALL, 'Actual output as a percentage of rated output'],
  ['THD_I_PRE', 'Current THD before compensation', '%', 0, 500, 3, 'avg', true, false, [AHF], 'Upstream (source-side) current THD'],
  ['THD_I_POST', 'Current THD after compensation', '%', 0, 500, 3, 'avg', true, false, [AHF], 'Downstream (load-side) current THD'],
  // ── Equipment health ──────────────────────────────────────────────────────
  ['DC_BUS_VOLTAGE', 'DC bus voltage', 'V', 0, 2000, 2, 'avg', false, false, ALL, 'DC link voltage'],
  ['TEMPERATURE', 'Heatsink temperature', 'degC', -40, 150, 2, 'avg', true, false, ALL, 'Power-stage temperature'],
  ['FAN_SPEED', 'Fan speed', 'rpm', 0, 20000, 0, 'avg', false, false, ALL, 'Cooling fan speed'],
  ['MODULE_STATUS', 'Module status', 'code', 0, 255, 0, 'last', false, false, ALL, 'Vendor status word; interpreted by the device profile'],
  ['TRIP_CODE', 'Trip / fault code', 'code', 0, 65535, 0, 'last', false, false, ALL, 'Vendor fault code; 0 = no fault'],
];

// Capability lists per template profile — derived from METRICS.device_types.
function capabilitiesFor(type) {
  return METRICS.filter(m => m[9].includes(type)).map(m => m[0]);
}

export async function up(knex) {
  const safe = async (label, sql, params) => {
    const sp = `sp_iotmc_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[iot_metric_catalogue] skipped (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  for (const [code, name, unit, min, max, prec, agg, rising, counter, types, desc] of METRICS) {
    await safe(`metric_${code}`, `
      INSERT INTO iot_metric_definitions
        (company_id, metric_code, display_name, unit, data_type, description, device_types,
         min_physical, max_physical, precision_digits, aggregation, quality_policy,
         rising_is_bad, is_counter, enabled, version)
      VALUES (NULL, $1, $2, $3, 'number', $4, $5, $6, $7, $8, $9, 'valid_only', $10, $11, TRUE, 1)
      ON CONFLICT (metric_code) WHERE company_id IS NULL DO UPDATE
        SET display_name = EXCLUDED.display_name,
            unit         = EXCLUDED.unit,
            description  = EXCLUDED.description,
            device_types = EXCLUDED.device_types,
            min_physical = EXCLUDED.min_physical,
            max_physical = EXCLUDED.max_physical,
            aggregation  = EXCLUDED.aggregation,
            rising_is_bad= EXCLUDED.rising_is_bad,
            is_counter   = EXCLUDED.is_counter,
            updated_at   = NOW()
    `, [code, name, unit, desc, types, min, max, prec, agg, rising, counter]);
  }

  for (const type of [AHF, SVG, ST]) {
    await safe(`profile_${type}`, `
      INSERT INTO iot_device_profiles
        (company_id, profile_code, device_type, manufacturer, model, firmware, register_map_ver,
         protocol, addressing_mode, byte_order, word_order, default_sampling_s,
         capabilities, register_map, is_template, enabled)
      VALUES (NULL, $1, $2, NULL, NULL, NULL, NULL,
              'modbus_tcp', 'one_based', 'big', 'big', 60,
              $3, '[]'::jsonb, TRUE, TRUE)
      ON CONFLICT (profile_code) WHERE company_id IS NULL DO UPDATE
        SET capabilities = EXCLUDED.capabilities, updated_at = NOW()
    `, [`GENERIC_${type}`, type, capabilitiesFor(type)]);
  }

  console.log(`[migration 20260914000002] iot metric catalogue: ${METRICS.length} metrics, 3 profile templates.`);
}

export async function down(knex) {
  try {
    await knex.raw(`DELETE FROM iot_device_profiles WHERE company_id IS NULL AND is_template = TRUE`);
    await knex.raw(`DELETE FROM iot_metric_definitions WHERE company_id IS NULL`);
  } catch { /* ignore */ }
}
