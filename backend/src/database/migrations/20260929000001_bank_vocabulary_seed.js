/**
 * 20260929000001 — `employees.bank_name` becomes a master-data vocabulary.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * Bank Name was a free-text <input> on both Add Employee and Edit Employee,
 * and the live column shows precisely what an unvalidated payment field
 * collects. Company 1 holds, in four rows:
 *
 *     'ICICI'   'kljfsdkjf'   'vdsf'   'czxc'
 *
 * Three of the four are keyboard mash. The fourth is a real bank written in a
 * form that will not reconcile against 'ICICI Bank' or 'ICICI Bank Ltd' — and
 * this column is half of the payment instruction payroll writes into a
 * NEFT/RTGS advice file. A bank name that does not match is a salary that does
 * not arrive.
 *
 * ── Why master_values and not a new table ───────────────────────────────────
 * There is NO bank master in this schema. The three bank-shaped tables are
 * `bank_accounts` (the COMPANY's own accounts), `vendor_bank_details` and
 * `bank_statement_lines` — all instances of an account, none a vocabulary of
 * bank names. Binding an employee's bank to any of them would be the
 * "unrelated duplicate" trap.
 *
 * `master_values` + an entry in modules/master/vocabularies.js IS the mechanism
 * this codebase already has for a user-extensible list of standard names; see
 * that file's header. So this is a registry row and a seed, not a fourteenth
 * table and a per-vocabulary migration.
 *
 * ── Scope: SHARED, not per-company ──────────────────────────────────────────
 * company_id NULL. The list of banks operating in India is not a tenant's
 * private data, and a per-tenant copy would mean twelve tenants each curating
 * the same list and drifting apart — the exact failure vocabularies.js exists
 * to stop. A tenant that needs an unlisted bank adds it through `+ Add new…`,
 * and that row lands with THEIR company_id, so a local co-operative bank does
 * not leak into every other tenant's dropdown.
 *
 * ── Provenance of the list ──────────────────────────────────────────────────
 * The RBI's scheduled commercial banks: the 12 public sector banks, the 21
 * private sector banks, the 6 payments/small-finance banks an employee is
 * realistically paid into, and the foreign banks with an Indian retail
 * presence. Names are the legal short form each bank uses on its own IFSC
 * records, so a name here matches what an IFSC lookup returns.
 *
 * ⚠ NOT a closed list. Banks merge, and small co-operative banks are
 * legitimate salary accounts. The registry entry opens `+ Add new…` to the HR,
 * payroll and finance roles for exactly that reason. Rejecting a real bank
 * because it is not in a seed is worse than the free text this replaces.
 *
 * ── Existing data is NOT touched ────────────────────────────────────────────
 * No UPDATE of employees.bank_name. The four live values stay exactly as they
 * are: MasterSelect offers a stored value the master does not hold back as its
 * own option ("orphan"), so 'kljfsdkjf' still renders on that employee's record
 * instead of blanking and being wiped on the next save. Cleaning them up is an
 * HR data decision, not a migration's.
 */

/**
 * Seeded banks, in the order they are offered.
 *
 * Public sector first (they hold most salary accounts in the industrial
 * segment Pulse is sold into), then private, then payments/small-finance, then
 * foreign. Within each group, alphabetical.
 */
const BANKS = [
  // ── Public sector ──────────────────────────────────────────────────────────
  'Bank of Baroda',
  'Bank of India',
  'Bank of Maharashtra',
  'Canara Bank',
  'Central Bank of India',
  'Indian Bank',
  'Indian Overseas Bank',
  'Punjab & Sind Bank',
  'Punjab National Bank',
  'State Bank of India',
  'UCO Bank',
  'Union Bank of India',

  // ── Private sector ─────────────────────────────────────────────────────────
  'Axis Bank',
  'Bandhan Bank',
  'City Union Bank',
  'CSB Bank',
  'DCB Bank',
  'Dhanlaxmi Bank',
  'Federal Bank',
  'HDFC Bank',
  'ICICI Bank',
  'IDBI Bank',
  'IDFC FIRST Bank',
  'IndusInd Bank',
  'Jammu & Kashmir Bank',
  'Karnataka Bank',
  'Karur Vysya Bank',
  'Kotak Mahindra Bank',
  'Nainital Bank',
  'RBL Bank',
  'South Indian Bank',
  'Tamilnad Mercantile Bank',
  'YES Bank',

  // ── Small finance / payments ───────────────────────────────────────────────
  'AU Small Finance Bank',
  'Equitas Small Finance Bank',
  'ESAF Small Finance Bank',
  'Jana Small Finance Bank',
  'Ujjivan Small Finance Bank',
  'India Post Payments Bank',

  // ── Foreign banks with an Indian retail presence ───────────────────────────
  'Citibank',
  'DBS Bank India',
  'Deutsche Bank',
  'HSBC India',
  'Standard Chartered Bank',
];

export async function up(knex) {
  // ⚠ `knex` here is a pg shim, not knex: bindings are $1/$2, never `?` —
  // Postgres parses `?` as the jsonb-exists operator. See
  // [[project_migration_runner_pg_shim]].
  for (let i = 0; i < BANKS.length; i++) {
    await knex.raw(
      `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
       VALUES ('BANK', $1, NULL, $2, NULL, true)
       ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
      [BANKS[i], i + 1],
    );
  }
}

export async function down(knex) {
  // Only the shared seed rows. A tenant's own additions (company_id NOT NULL)
  // are their data and survive a rollback — dropping them would lose a bank
  // somebody is actually paid into.
  await knex.raw(
    `DELETE FROM master_values WHERE type = 'BANK' AND company_id IS NULL`,
  );
}

export const BANK_SEED = BANKS;
