/**
 * 20260917000001_item_category_backfill.js
 *
 * Item Master's Category filter matched nothing because NOTHING WAS FILED.
 *
 * `item_categories` has held twelve live categories since
 * 20260713000001_component_category_vendor_pricing, and `inventory_items`
 * has carried the FK since the same migration — but every one of the 33 live
 * item rows still had `category_id IS NULL`. The master, the FK, the picker in
 * the Add/Edit drawer and the `category_id` filter in the repository were all
 * built and all correct; the assignment step never happened. So the "All
 * Categories" dropdown offered twelve options and every one of them returned
 * an empty table — indistinguishable, from the screen, from a broken filter.
 *
 * ── WHICH AXIS A CATEGORY IS ────────────────────────────────────────────────
 * The category master's own migration says why it exists: items "previously
 * only had a free-text item_type (Raw Material / Finished Good…); there was no
 * true category to file or roll up a component under". So the two columns are
 * different axes and must not be made to agree:
 *
 *     item_type  = the ROLE a part plays in the build (Raw Material,
 *                  Sub Assembly, Finished Good, Consumable, Fixed Asset)
 *     category   = the COMMODITY FAMILY it is bought and rolled up as
 *                  (Electrical, Electronics, Mechanical, Office Supplies)
 *
 * That is why Copper Busbar 100A is filed ELEC and not RAWM even though its
 * item_type is 'Raw Material': RAWM on the commodity axis would be a restatement
 * of the type column, which is exactly the redundancy the master was created to
 * remove. Spend analytics, the sourcing-strategy service and the RFx scorer all
 * roll up on category_id; a category that merely echoes item_type rolls up
 * nothing useful.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 * Company 1's fourteen items — the rows whose names carry enough evidence to
 * file them. The other nineteen live rows are two-item ('ABB MCB 16A 3-Pole',
 * 'Relay 24V DC') fixtures cloned across ten test tenants by a leaked test run;
 * they are deliberately left alone rather than swept in, since a data
 * remediation must touch only the rows it actually measured.
 *
 * Idempotent three ways: keyed on item_code within company 1, applied only
 * where category_id IS NULL (a human's later reclassification is never
 * overwritten), and resolving the category by category_code so it is the code —
 * not a serial id that differs per environment — that has to match.
 */

const ASSIGNMENTS = [
  // Power distribution and panel build — the electrical commodity family.
  ['BA-200',     'ELEC'],  // Busbar Assembly 400A
  ['CBL-25',     'ELEC'],  // Control Cable 2.5 sqmm
  ['CH-400',     'ELEC'],  // Cable Harness Set
  ['CP-1000',    'ELEC'],  // Control Panel 400A
  ['CU-BUS-100', 'ELEC'],  // Copper Busbar 100A
  ['TB-32',      'ELEC'],  // Terminal Block 32A

  // Low-voltage control devices and IT hardware — Electronics exists in the
  // master precisely to be distinguishable from Electrical, so the 24V DC
  // control gear is filed apart from the power path.
  ['RLY-24',     'ELCT'],  // Relay 24V DC
  ['RM-300',     'ELCT'],  // Relay Module 24V
  ['ITM-003',    'ELCT'],  // Laptop Dell Inspiron
  ['ITM-005',    'ELCT'],  // Network Switch 24-port

  ['ENC-800',    'MECH'],  // Enclosure 800x600x250 — sheet-metal fabrication

  ['ITM-001',    'OFFC'],  // Office Paper A4
  ['ITM-002',    'OFFC'],  // Printer Ink Cartridge
  ['ITM-004',    'OFFC'],  // Desk Chair
];

// ⚠ `knex` here is the pg shim, not knex: bindings are $1/$2, never `?`.
export async function up(knex) {
  for (const [itemCode, categoryCode] of ASSIGNMENTS) {
    await knex.raw(
      `UPDATE inventory_items ii
          SET category_id = c.id
         FROM item_categories c
        WHERE ii.item_code  = $1
          AND ii.company_id = 1
          AND ii.category_id IS NULL
          AND ii.deleted_at IS NULL
          AND c.category_code = $2
          AND c.company_id    = 1
          AND c.deleted_at IS NULL`,
      [itemCode, categoryCode]
    );
  }
}

// Unfiles only the rows this migration could have filed, and only where they
// still carry the category it assigned — a reclassification made since is left.
export async function down(knex) {
  for (const [itemCode, categoryCode] of ASSIGNMENTS) {
    await knex.raw(
      `UPDATE inventory_items ii
          SET category_id = NULL
         FROM item_categories c
        WHERE ii.item_code  = $1
          AND ii.company_id = 1
          AND ii.category_id = c.id
          AND c.category_code = $2
          AND c.company_id    = 1`,
      [itemCode, categoryCode]
    );
  }
}
