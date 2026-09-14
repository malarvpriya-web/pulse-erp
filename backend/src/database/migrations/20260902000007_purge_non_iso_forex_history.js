/**
 * Finish the forex purge — with the right predicate this time.
 *
 * WHY THIS EXISTS
 * ---------------
 * 20260902000006 deleted fabricated rows from `forex_rates` and
 * `forex_rate_history` by testing the *shape* of `currency_code`:
 *
 *   DELETE ... WHERE currency_code !~ '^[A-Z]{3}$'
 *
 * That cleared `forex_rates`, whose seeded codes were 'FR-', '944', '952' —
 * visibly not codes. It removed **nothing** from `forex_rate_history`, whose
 * five rows are all keyed on **'FRH'**: the seeder's abbreviation for the table
 * name, which is three uppercase letters and therefore passes the shape test
 * perfectly.
 *
 * ⚠⚠ **A format check is not an existence check.** 'FRH' is exactly as
 * well-formed as 'GBP' and exactly as real as 'MHS-07907-SEED06907'. Validating
 * the shape of an identifier says nothing about whether the thing it identifies
 * exists, and a fabricated value that satisfies the format is the one that
 * survives cleanup — which is the same reason §146.2 flagged the 899 rows as
 * *more* dangerous once they had been set to a plausible 0.
 *
 * The predicate is now membership in ISO 4217, which is what "is this a
 * currency" actually means. The list below is the active ISO 4217 alphabetic
 * set; a code outside it does not denote a currency, so no exchange rate can
 * exist for it and the row cannot be corrected — only removed.
 *
 * WHY THIS IS SAFE
 * ----------------
 * Verified before writing: `forex_rate_history` has no inbound foreign keys, and
 * all five rows carry `currency_code = 'FRH'`, `source` values from the seeder's
 * vocabulary ('Standard', 'General', 'Primary', 'Routine'), `created_at` inside
 * the 2026-08-20 seed run, and `rate_vs_inr` on the seeder's 1250.5 + 175i
 * series. Scoped by predicate rather than truncated, so a genuine row added
 * later survives — on this database that happens to be none, which is the
 * correct outcome for a table containing only fabricated history.
 *
 * The generator defect behind 'FRH' is fixed too: `currency_code` was reaching
 * the seeder's generic `_code$` branch (abbreviation + sequence, truncated to
 * the column's 3 characters) because nothing classified currency first. It now
 * draws from ISO 4217.
 */

// Active ISO 4217 alphabetic codes.
const ISO_4217 = [
  'AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT',
  'BGN','BHD','BIF','BMD','BND','BOB','BOV','BRL','BSD','BTN','BWP','BYN','BZD',
  'CAD','CDF','CHE','CHF','CHW','CLF','CLP','CNY','COP','COU','CRC','CUP','CVE',
  'CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP','GBP','GEL',
  'GHS','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR',
  'IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR','KMF','KPW','KRW','KWD',
  'KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK',
  'MNT','MOP','MRU','MUR','MVR','MWK','MXN','MXV','MYR','MZN','NAD','NGN','NIO',
  'NOK','NPR','NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON',
  'RSD','RUB','RWF','SAR','SBD','SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD',
  'SSP','STN','SVC','SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD',
  'TZS','UAH','UGX','USD','USN','UYI','UYU','UYW','UZS','VED','VES','VND','VUV',
  'WST','XAF','XCD','XCG','XOF','XPF','YER','ZAR','ZMW','ZWG',
];

export async function up(knex) {
  const results = [];
  for (const table of ['forex_rates', 'forex_rate_history']) {
    const { rows } = await knex.raw(
      `DELETE FROM ${table} WHERE UPPER(currency_code) <> ALL($1::text[])
       RETURNING currency_code`,
      [ISO_4217]
    );
    results.push(`${table}: ${rows?.length ?? 0}`);
  }
  console.log(`[20260902000007] purged rows keyed on a non-ISO-4217 currency — ${results.join(', ')}.`);
}

export async function down() {
  // Intentionally irreversible: these rows were keyed on codes that do not
  // denote any currency, so there is nothing correct to restore them to.
}
