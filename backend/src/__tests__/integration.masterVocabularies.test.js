/**
 * integration.masterVocabularies.test.js
 *
 * The /master/v/:vocab registry, driven through the REAL master router against
 * the REAL database.
 *
 * WHY THESE EXIST
 *
 * §172 moved thirteen hardcoded dropdown vocabularies behind one master so that
 * "+ Add new…" in a module form and Master Data Setup are the same list. Four
 * properties have to hold for that to be true rather than merely look true, and
 * each of them has a counterpart bug already shipped in this repo:
 *
 *  1. A value added through a module form is visible in Master Data Setup, and
 *     the reverse. Same endpoint, so this is really a test that the READ and the
 *     WRITE agree about scope — the class of bug where a row is created for one
 *     company and listed for another, or created and then invisible.
 *  2. Duplicates are refused case- and whitespace-insensitively. The pre-existing
 *     UNIQUE (type, code, company_id) does nothing when `code` is NULL, which is
 *     every row the UI creates.
 *  3. Writes are per-vocabulary. HR may add a qualification; HR may not add a
 *     vendor category. A single ADMIN_ROLES gate would have been simpler and
 *     would have handed every HR user the procurement taxonomy.
 *  4. One tenant cannot rename or retire the shared defaults every other tenant
 *     reads, and cannot touch another tenant's own rows at all.
 *
 * ⚠ EVERY NEGATIVE CASE IS PAIRED WITH A POSITIVE ONE. A permission suite that
 * only asserts "HR is refused" passes just as happily when the endpoint is
 * broken for everyone — see integration.projectsTenantIsolation.test.js, which
 * says the same thing for the same reason.
 *
 * Self-cleaning: everything this suite writes is prefixed ZZVOCAB and removed by
 * sweep(), which runs on the way IN as well as OUT. It touches no seeded row —
 * the shared defaults are only ever read, and asserted-unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }         = await import('../config/db.js');
const { default: masterRouter } = await import('../modules/master/master.routes.js');
const { REGISTRY, RESERVED_TYPES } = await import('../modules/master/vocabularies.js');

const TAG = 'ZZVOCAB';

/** An app whose caller holds exactly these roles, in exactly this company. */
function appAs(companyId, roles) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, roles, company_id: companyId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/master', masterRouter);
  return app;
}

let companyA, companyB;
let adminA, hrA, salesA, employeeA, adminB;

async function makeCompany(suffix) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Co ${suffix}`, `${TAG}${suffix}`]
  );
  return rows[0].id;
}

async function sweep() {
  await pool.query(`DELETE FROM master_values WHERE value LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM master_values WHERE company_id IN (SELECT id FROM companies WHERE code LIKE $1)`, [`${TAG}%`]);
  await pool.query(`DELETE FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
}

beforeAll(async () => {
  await sweep();
  companyA = await makeCompany('A');
  companyB = await makeCompany('B');
  adminA    = appAs(companyA, ['admin']);
  hrA       = appAs(companyA, ['hr_manager']);
  salesA    = appAs(companyA, ['sales_manager']);
  employeeA = appAs(companyA, ['employee']);
  adminB    = appAs(companyB, ['admin']);
});

afterAll(async () => { await sweep(); });

// ── The registry itself ──────────────────────────────────────────────────────
describe('GET /master/v — the registry', () => {
  it('lists every vocabulary with the endpoint and the roles the writes enforce', async () => {
    const res = await request(adminA).get('/master/v');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(REGISTRY.length);

    const industries = res.body.find(v => v.key === 'industries');
    expect(industries).toMatchObject({ label: 'Industry', module: 'CRM', endpoint: '/master/v/industries' });
    // The frontend hides "+ Add new…" using exactly this list, so if it stopped
    // being served the option would be offered to users whose POST is a 403.
    expect(industries.roles).toEqual(expect.arrayContaining(['admin', 'sales_manager']));
    expect(industries.roles).not.toContain('employee');
  });

  it('does not expose the types that belong to something else', async () => {
    const res = await request(adminA).get('/master/v');
    const exposed = new Set(res.body.map(v => v.type));
    for (const reserved of RESERVED_TYPES) expect(exposed.has(reserved)).toBe(false);
    // LEAVE_TYPE in particular: the live master is the `leave_types` TABLE, and
    // serving the six shadow rows in master_values would give leave types two
    // sources of truth — the thing this module exists to prevent.
    expect(exposed.has('LEAVE_TYPE')).toBe(false);
  });

  it('refuses an unknown vocabulary rather than guessing', async () => {
    const res = await request(adminA).get('/master/v/not-a-vocabulary');
    expect(res.status).toBe(404);
  });

  it('refuses a reserved type addressed by a plausible key', async () => {
    // 'priorities' is in the user-facing wish list and is deliberately NOT a
    // vocabulary: 29 tables compare and sort `priority` in code.
    const res = await request(adminA).get('/master/v/priorities');
    expect(res.status).toBe(404);
  });
});

// ── Single source of truth ───────────────────────────────────────────────────
describe('a value added from a module form is the same row Master Data Setup lists', () => {
  it('appears in the list immediately, for the company that added it', async () => {
    const name = `${TAG} Marine Engineering`;
    const created = await request(salesA).post('/master/v/industries').send({ name });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, is_shared: false });

    // Same endpoint Master Data Setup's tab reads.
    const list = await request(adminA).get('/master/v/industries');
    expect(list.body.map(r => r.name)).toContain(name);
  });

  it('does not leak into another tenant', async () => {
    const list = await request(adminB).get('/master/v/industries');
    expect(list.body.map(r => r.name)).not.toContain(`${TAG} Marine Engineering`);
    // Paired positive: company B still sees the shared defaults, so the absence
    // above is scoping and not a broken endpoint.
    expect(list.body.map(r => r.name)).toContain('Technology');
  });

  it('is gone from the list once retired, and the retire is a soft delete', async () => {
    const name = `${TAG} Retire Me`;
    const created = await request(salesA).post('/master/v/industries').send({ name });
    const del = await request(salesA).delete(`/master/v/industries/${created.body.id}`);
    expect(del.status).toBe(200);

    const list = await request(adminA).get('/master/v/industries');
    expect(list.body.map(r => r.name)).not.toContain(name);

    // The row survives, so a record already carrying the value keeps its text.
    const { rows } = await pool.query(`SELECT is_active FROM master_values WHERE id = $1`, [created.body.id]);
    expect(rows[0]).toMatchObject({ is_active: false });
  });
});

// ── Duplicate prevention ─────────────────────────────────────────────────────
describe('duplicate prevention', () => {
  it('refuses the same value again, and says which value collided', async () => {
    const name = `${TAG} Duplicate Source`;
    expect((await request(salesA).post('/master/v/lead-sources').send({ name })).status).toBe(201);

    const again = await request(salesA).post('/master/v/lead-sources').send({ name });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain(name);
    expect(again.body.existing).toHaveProperty('id');
  });

  it('refuses it regardless of case and surrounding whitespace', async () => {
    const res = await request(salesA).post('/master/v/lead-sources')
      .send({ name: `   ${TAG.toLowerCase()} duplicate SOURCE  ` });
    expect(res.status).toBe(409);
  });

  it('refuses a value that duplicates a SHARED default', async () => {
    // No index can express this one — the shared row belongs to no company, so
    // a per-company unique constraint never sees the collision. Without the
    // check the dropdown would simply show "Technology" twice.
    const res = await request(salesA).post('/master/v/industries').send({ name: 'technology' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Technology');
  });

  it('lets two different tenants each hold their own copy of a value', async () => {
    const name = `${TAG} Shared Word`;
    expect((await request(adminA).post('/master/v/project-types').send({ name })).status).toBe(201);
    expect((await request(adminB).post('/master/v/project-types').send({ name })).status).toBe(201);
  });

  it('rejects an empty name and an over-long one', async () => {
    expect((await request(salesA).post('/master/v/industries').send({ name: '   ' })).status).toBe(400);
    expect((await request(salesA).post('/master/v/industries').send({ name: 'x'.repeat(101) })).status).toBe(400);
  });
});

// ── Permissions ──────────────────────────────────────────────────────────────
describe('writes are per-vocabulary, not one blanket admin gate', () => {
  it('lets any authenticated user READ — these are reference data', async () => {
    // Self-service forms (travel, expense) need them, so a read gate keyed to
    // admin would empty those dropdowns for the people who use them most.
    const res = await request(employeeA).get('/master/v/travel-types');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('refuses a write from a user with no master role anywhere', async () => {
    const res = await request(employeeA).post('/master/v/industries').send({ name: `${TAG} Nope` });
    expect(res.status).toBe(403);
  });

  it('lets HR add an HR vocabulary', async () => {
    const res = await request(hrA).post('/master/v/qualifications').send({ name: `${TAG} B.Voc` });
    expect(res.status).toBe(201);
  });

  it('refuses HR the procurement and CRM vocabularies', async () => {
    expect((await request(hrA).post('/master/v/vendor-categories').send({ name: `${TAG} X` })).status).toBe(403);
    expect((await request(hrA).post('/master/v/industries').send({ name: `${TAG} Y` })).status).toBe(403);
  });

  it('lets an admin write any of them', async () => {
    expect((await request(adminA).post('/master/v/vendor-categories').send({ name: `${TAG} Castings` })).status).toBe(201);
    expect((await request(adminA).post('/master/v/qualifications').send({ name: `${TAG} M.Tech` })).status).toBe(201);
  });
});

// ── Tenant isolation of the writes ───────────────────────────────────────────
describe('shared defaults and other tenants rows are not writable', () => {
  it('refuses to rename a shared default, and explains why', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM master_values WHERE type = 'INDUSTRY' AND company_id IS NULL LIMIT 1`
    );
    const res = await request(adminA).put(`/master/v/industries/${rows[0].id}`).send({ name: `${TAG} Hijacked` });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/shared across companies/i);

    // And it really is unchanged — a 409 that still wrote would be worse than
    // no guard at all, because nobody would look again.
    const after = await pool.query(`SELECT value FROM master_values WHERE id = $1`, [rows[0].id]);
    expect(after.rows[0].value).not.toContain(TAG);
  });

  it('refuses to retire a shared default', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM master_values WHERE type = 'INDUSTRY' AND company_id IS NULL LIMIT 1`
    );
    expect((await request(adminA).delete(`/master/v/industries/${rows[0].id}`)).status).toBe(409);
    const after = await pool.query(`SELECT is_active FROM master_values WHERE id = $1`, [rows[0].id]);
    expect(after.rows[0].is_active).toBe(true);
  });

  it('answers 404 — not 409 — for another tenant row, which it must not confirm exists', async () => {
    const created = await request(adminB).post('/master/v/project-types').send({ name: `${TAG} B Only` });
    expect(created.status).toBe(201);

    expect((await request(adminA).put(`/master/v/project-types/${created.body.id}`).send({ name: `${TAG} Stolen` })).status).toBe(404);
    expect((await request(adminA).delete(`/master/v/project-types/${created.body.id}`)).status).toBe(404);

    // Paired positive: its owner can still rename it, so the 404s above are
    // scoping rather than the route being broken for everyone.
    expect((await request(adminB).put(`/master/v/project-types/${created.body.id}`).send({ name: `${TAG} B Renamed` })).status).toBe(200);
  });
});

// ── The server-side readers ──────────────────────────────────────────────────
describe('vocabularyValues — the validator reads the same master', () => {
  it('returns a value added through the API, so a validator cannot null it', async () => {
    const { vocabularyValues, invalidateVocabularyCache } = await import('../shared/masterVocabulary.js');
    const name = `${TAG} Retrofit`;
    expect((await request(adminA).post('/master/v/project-types').send({ name })).status).toBe(201);

    invalidateVocabularyCache();
    const values = await vocabularyValues('PROJECT_TYPE', companyA, []);
    expect(values).toContain(name);
    // This is the whole point: complaints/servicedesk used to do
    // `PROJECT_TYPES.includes(x) ? x : null` against a hardcoded array, so a
    // type added here was offered in the dropdown and then written as NULL.
  });

  it('canonicalValue matches case-insensitively and returns the master spelling', async () => {
    const { canonicalValue, invalidateVocabularyCache } = await import('../shared/masterVocabulary.js');
    invalidateVocabularyCache();
    expect(await canonicalValue('PROJECT_TYPE', 'epc', companyA, [])).toBe('EPC');
    expect(await canonicalValue('PROJECT_TYPE', '  Epc  ', companyA, [])).toBe('EPC');
    expect(await canonicalValue('PROJECT_TYPE', 'not a type', companyA, [])).toBeNull();
    expect(await canonicalValue('PROJECT_TYPE', '', companyA, [])).toBeNull();
  });

  it('reads zones from master_zones, which is a table and not a master_values type', async () => {
    const { vocabularyValues, invalidateVocabularyCache } = await import('../shared/masterVocabulary.js');
    invalidateVocabularyCache();
    const zones = await vocabularyValues('ZONE', companyA, ['FALLBACK_ONLY']);
    expect(zones).not.toEqual(['FALLBACK_ONLY']);
    expect(zones.length).toBeGreaterThan(0);
  });

  it('falls back rather than narrowing everything to nothing when the read fails', async () => {
    const { vocabularyValues, invalidateVocabularyCache } = await import('../shared/masterVocabulary.js');
    invalidateVocabularyCache();
    // A type nothing has ever seeded stands in for an unseeded master: the
    // caller gets its own list back, not an empty one that would turn every
    // incoming zone and service type into NULL.
    const out = await vocabularyValues('ZZ_NO_SUCH_TYPE', companyA, ['Alpha', 'Beta']);
    expect(out).toEqual(['Alpha', 'Beta']);
  });
});

// ── §173: the two-level expense taxonomy ─────────────────────────────────────
//
// Expense was one of the two gaps §172 reported and did not close, because it
// was three vocabularies for one domain — a hardcoded two-level list in
// ExpenseClaims, a different lowercase one in EmployeeSelfService, and an
// `expense_categories` table that 11 curated rows sat in and nothing read.
// A flat vocabulary could not represent it; `master_values.parent_id` could.
describe('a two-level vocabulary', () => {
  it('returns every child with its parent named, when no parent is given', async () => {
    // This is what Master Data Setup wants: the whole list, each row saying
    // which type it belongs to.
    const res = await request(adminA).get('/master/v/expense-categories');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(20);
    for (const row of res.body) expect(row.parent_name).toBeTruthy();
  });

  it('narrows to one parent when asked, and the parent is matched by NAME', async () => {
    // By name, not id: the page that needs the child list already holds the
    // parent's stored text — it is what is on the record.
    const res = await request(adminA).get('/master/v/expense-categories?parent=Food');
    expect(res.status).toBe(200);
    expect(res.body.map(r => r.name)).toEqual(expect.arrayContaining(['Breakfast', 'Lunch', 'Dinner']));
    expect(res.body.map(r => r.name)).not.toContain('Hotel');
  });

  it('matches the parent case-insensitively, as the stored text may drift', async () => {
    const res = await request(adminA).get('/master/v/expense-categories?parent=food');
    expect(res.body.map(r => r.name)).toContain('Lunch');
  });

  it('answers an unknown parent with NOTHING, not everything', async () => {
    // The dangerous default. A cascading picker showing all children under a
    // parent that does not exist invites choosing a value the record cannot
    // mean, and it is the failure mode a missing WHERE clause produces.
    const res = await request(adminA).get('/master/v/expense-categories?parent=NoSuchType');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('gives every expense type at least one category', async () => {
    // A cascade whose second step is empty is a dead end. 'Other' shipped that
    // way for one draft of the migration, because its only category name was
    // already taken by another type and the ON CONFLICT silently dropped it.
    const types = await request(adminA).get('/master/v/expense-types');
    expect(types.body.length).toBeGreaterThan(0);
    for (const t of types.body) {
      const kids = await request(adminA).get(`/master/v/expense-categories?parent=${encodeURIComponent(t.name)}`);
      expect(kids.body.length, `expense type "${t.name}" has no categories`).toBeGreaterThan(0);
    }
  });

  it('keeps the three policy-mapped types, spelled exactly as the code compares them', async () => {
    // travel-reimbursement.routes.js and travel-policy.routes.js both do
    // `expense_type === 'Accommodation'` → hotel_limit_per_day, and so on.
    // Rename one of these and the claim silently falls to miscellaneous_limit.
    const res = await request(adminA).get('/master/v/expense-types');
    expect(res.body.map(r => r.name)).toEqual(expect.arrayContaining(['Travel', 'Accommodation', 'Food']));
  });

  it('creates a child under the parent it was given', async () => {
    const name = `${TAG} Visa Fee`;
    const created = await request(adminA).post('/master/v/expense-categories').send({ name, parent: 'Travel' });
    expect(created.status).toBe(201);

    const under = await request(adminA).get('/master/v/expense-categories?parent=Travel');
    expect(under.body.map(r => r.name)).toContain(name);
    // Paired negative: it is under Travel and nowhere else.
    const elsewhere = await request(adminA).get('/master/v/expense-categories?parent=Food');
    expect(elsewhere.body.map(r => r.name)).not.toContain(name);
  });

  it('refuses a child with no parent, and one with a parent that does not exist', async () => {
    // Written without a parent it would be a row no cascading picker ever shows
    // again — accepted, invisible, and impossible to find in order to delete.
    const noParent = await request(adminA).post('/master/v/expense-categories').send({ name: `${TAG} Orphan` });
    expect(noParent.status).toBe(400);
    expect(noParent.body.error).toMatch(/expense type is required/i);

    const badParent = await request(adminA).post('/master/v/expense-categories')
      .send({ name: `${TAG} Orphan 2`, parent: 'NoSuchType' });
    expect(badParent.status).toBe(400);
    expect(badParent.body.error).toMatch(/not an expense type/i);

    // Neither was written.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM master_values WHERE type = 'EXPENSE_CATEGORY' AND value LIKE $1`,
      [`${TAG} Orphan%`]
    );
    expect(rows[0].n).toBe(0);
  });

  it('exposes parentOf on the registry so a picker knows to cascade', async () => {
    const res = await request(adminA).get('/master/v');
    const child  = res.body.find(v => v.key === 'expense-categories');
    const parent = res.body.find(v => v.key === 'expense-types');
    expect(child.parentOf).toBe('expense-types');
    expect(child.parentLabel).toBe('Expense Type');
    // The parent itself is a normal one-level vocabulary.
    expect(parent.parentOf).toBeUndefined();
  });

  it('leaves a single-level vocabulary alone when a parent is passed', async () => {
    // ?parent= on a flat vocabulary must be ignored, not treated as a filter
    // that matches nothing.
    const res = await request(adminA).get('/master/v/industries?parent=Whatever');
    expect(res.body.length).toBeGreaterThan(0);
  });
});
