/**
 * Give `master_uom` real units, so the item form can read from it.
 *
 * Two problems met here.
 *
 * 1. `master_uom` held five placeholder rows — code `MU-07982-SEED06982`, name
 *    "SEED Master Uom 1" — minted by the empty-table seeding pass, not by
 *    anyone configuring units. They are the entire contents of the table.
 *
 * 2. Nothing read the table anyway. ItemMaster.jsx carried its own hard-coded
 *    `UNITS` array ('pcs','kg','ltr',…) and Master Setup's Units tab wrote to a
 *    master no screen consulted, so a unit added there never appeared on an
 *    item.
 *
 * Wiring the item form to the master is the point of the change this belongs
 * to; seeding it with the placeholder rows still in place would have offered
 * "SEED Master Uom 1" as a unit of measure.
 *
 * Deliberately NOT normalising the units already stored on records. There are
 * ~28 tables carrying a free-text unit/uom column and `inventory_items` alone
 * holds 'Nos', 'Pcs' and 'Ream' — three spellings the hard-coded lower-case
 * list never matched either. Rewriting them is a separate, much wider change;
 * the picker keeps an unrecognised stored value as its own option instead, so
 * an existing item is not silently re-unitised on its next save.
 *
 * Codes are upper-case because POST /master/uom upper-cases what it inserts
 * (master.routes.js) — seeding any other way would drift on the first UI add.
 */

const UNITS = [
  // code,   name,             category
  ['NOS',   'Numbers',         'Count'],
  ['PCS',   'Pieces',          'Count'],
  ['SET',   'Set',             'Count'],
  ['PAIR',  'Pair',            'Count'],
  ['DOZ',   'Dozen',           'Count'],
  ['BOX',   'Box',             'Packaging'],
  ['ROLL',  'Roll',            'Packaging'],
  ['CAN',   'Can',             'Packaging'],
  ['SHEET', 'Sheet',           'Packaging'],
  ['COIL',  'Coil',            'Packaging'],
  ['REAM',  'Ream',            'Packaging'],
  ['PKT',   'Packet',          'Packaging'],
  ['KG',    'Kilogram',        'Weight'],
  ['G',     'Gram',            'Weight'],
  ['TON',   'Metric Tonne',    'Weight'],
  ['LTR',   'Litre',           'Volume'],
  ['ML',    'Millilitre',      'Volume'],
  ['MTR',   'Metre',           'Length'],
  ['MM',    'Millimetre',      'Length'],
  ['FT',    'Feet',            'Length'],
  ['INCH',  'Inch',            'Length'],
  ['SQM',   'Square Metre',    'Area'],
  ['SQFT',  'Square Feet',     'Area'],
  ['HR',    'Hour',            'Time'],
  ['DAY',   'Day',             'Time'],
];

export async function up(knex) {
  // Retire the seeded placeholders the same way the delete route does, so an
  // item that somehow references one keeps resolving the text.
  const { rows: retired } = await knex.raw(`
    UPDATE master_uom
       SET is_active = false
     WHERE is_active = true
       AND (code LIKE 'MU-%' OR name ILIKE 'SEED %')
    RETURNING code
  `);
  if (retired?.length) {
    console.log(`[20260911000002] retired ${retired.length} placeholder unit row(s)`);
  }

  // ON CONFLICT on the code UNIQUE: re-running must not fail, and must not
  // clobber a name an admin has since corrected — it only re-activates.
  for (const [code, name, category] of UNITS) {
    await knex.raw(
      `INSERT INTO master_uom (code, name, category, is_active)
            VALUES ($1, $2, $3, true)
       ON CONFLICT (code) DO UPDATE SET is_active = true`,
      [code, name, category]
    );
  }
  console.log(`[20260911000002] seeded ${UNITS.length} unit(s) of measure`);
}

/**
 * No down. Re-inserting "SEED Master Uom 1" restores the defect, and any item
 * saved against a real unit in the meantime would be left pointing at a code
 * the master no longer offers.
 */
export async function down() {
  // intentionally empty
}
