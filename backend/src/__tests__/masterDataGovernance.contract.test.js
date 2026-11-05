/**
 * masterDataGovernance.contract.test.js — the Master Data management contract
 * (2026-09-29).
 *
 * WHAT THIS PINS
 * --------------
 * The rules a master-data screen has to keep, expressed against the source so a
 * refactor that drops one is caught without a database:
 *
 *   1. Retired values are hidden BY DEFAULT. Every <MasterSelect> in the app
 *      calls these endpoints with no query string; `include_inactive` is opt-in
 *      and only Master Data Setup sends it. Getting this backwards puts a
 *      retired department in the Add Employee dropdown, which is the one thing
 *      deactivation exists to prevent.
 *   2. Usage counting is opt-in too, so a picker pays nothing for it.
 *   3. Delete is usage-aware: hard delete only when nothing references the
 *      value, deactivate otherwise.
 *   4. Duplicate protection is NORMALISED and enforced at the database, not
 *      only in a handler.
 *   5. Every usage reference points at a table+column that exists.
 *   6. Branch stays an ENTITY, not a vocabulary.
 *
 * `masterDataGovernance.integration.test.js` proves the same rules behaviourally
 * against the live database. This file is the cheap half.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGISTRY, BY_KEY } from '../modules/master/vocabularies.js';
import { USAGE, usageForVocab, describeUsage } from '../modules/master/usage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');
const front = (rel) => fs.readFileSync(path.join(HERE, '../../../frontend/src', rel), 'utf8');

const MASTER    = src('modules/master/master.routes.js');
const USAGE_SRC = src('modules/master/usage.js');
const BRANCHES  = src('modules/admin/branchManagement.routes.js');
const MIGRATION = src('database/migrations/20260929000002_master_data_governance.js');

const SETUP_UI  = front('features/admin/pages/MasterSetup.jsx');
const SELECT_UI = front('components/core/MasterSelect.jsx');
const BRANCH_UI = front('features/admin/pages/BranchManagement.jsx');

// ═════════════════════════════════════════════════════════════════════════════
describe('active-only is the DEFAULT on every read', () => {
  it('include_inactive is opt-in', () => {
    expect(MASTER).toMatch(/const wantsInactive = \(req\) =>/);
    // The clause is emitted UNLESS asked otherwise — the inverse would default
    // a picker to showing retired values.
    expect(MASTER).toMatch(/wantsInactive\(req\) \? '' : ` AND \$\{alias\}is_active = true`/);
  });

  it('usage counting is opt-in too', () => {
    expect(MASTER).toMatch(/const wantsUsage = \(req\) =>/);
    expect(MASTER).toMatch(/if \(!wantsUsage\(req\)[\s\S]{0,60}return rows;/);
  });

  it('MasterSelect never asks for retired values', () => {
    // The picker's load() must stay a bare GET. A stray include_inactive here
    // is the whole bug, app-wide, in one character.
    expect(SELECT_UI).not.toMatch(/include_inactive/);
    expect(SELECT_UI).toMatch(/await api\.get\(endpoint\)/);
  });

  it('Master Data Setup DOES ask for them, and for usage', () => {
    expect(SETUP_UI).toMatch(/include_inactive=1&usage=1/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('delete vs deactivate', () => {
  it('a hard delete is refused when the value is referenced', () => {
    expect(MASTER).toMatch(/const deleteVerdict = async/);
    expect(MASTER).toMatch(/askedHard && usage\.total > 0/);
    expect(MASTER).toMatch(/cannot be deleted/);
    expect(MASTER).toMatch(/remedy: 'deactivate'/);
  });

  it('a hard delete is allowed only when nothing references it', () => {
    expect(MASTER).toMatch(/hard: askedHard && usage\.total === 0/);
  });

  it('the default action is deactivation, on every master family', () => {
    // departments/designations/zones, grades/bands, and the vocabularies.
    const softDeletes = MASTER.match(/SET is_active = false/g) || [];
    expect(softDeletes.length).toBeGreaterThanOrEqual(3);
  });

  it('the UI asks for a hard delete only on an explicit Delete of an unused value', () => {
    // ⚠ STRENGTHENED 2026-09-29. It used to INFER the action from the usage
    // count (`${used ? '' : '?hard=1'}`), which is how one button silently
    // became the other. Delete and Deactivate are now separate controls and the
    // request carries the action the user actually chose.
    expect(SETUP_UI).toMatch(/const wantsHard = mode === 'delete' && !used;/);
    expect(SETUP_UI).toMatch(/\$\{wantsHard \? '\?hard=1' : ''\}/);
    // Both buttons exist; Delete is DISABLED when in use rather than hidden or
    // relabelled.
    expect(SETUP_UI).toMatch(/className="ms-btn-delete"[\s\S]{0,200}disabled=\{\(item\.usage_count \?\? 0\) > 0\}/);
    expect(SETUP_UI).toMatch(/className="ms-btn-deactivate"/);
    expect(SETUP_UI).toMatch(/Deactivate it instead/);
  });

  it('the confirm dialog names the action the user chose', () => {
    // Driven by the chosen MODE, not by the usage count — the two only agree by
    // coincidence, and "Delete" that confirms "Deactivate" is the lie this
    // whole split exists to remove.
    expect(SETUP_UI).toMatch(/const pendingMode = pendingDelete\?\.mode \?\? 'deactivate';/);
    expect(SETUP_UI).toMatch(/title=\{pendingMode === 'delete' \? `Delete \$\{label\}` : `Deactivate \$\{label\}`\}/);
    expect(SETUP_UI).toMatch(/confirmLabel=\{pendingMode === 'delete' \? 'Delete' : 'Deactivate'\}/);
    expect(SETUP_UI).toMatch(/variant=\{pendingMode === 'delete' \? 'danger' : 'primary'\}/);
    // …and the deactivate wording still promises existing records keep it.
    expect(SETUP_UI).toMatch(/already using it keep it/);
  });

  it('the row states its status and usage in words', () => {
    // "Active · Used by 8 employees" beside the actions, so "can I safely
    // change this?" is answered where the buttons are.
    expect(SETUP_UI).toMatch(/const StatusLine = /);
    expect(SETUP_UI).toMatch(/\{active \? 'Active' : 'Inactive'\}/);
    expect(SETUP_UI).toMatch(/Used by \$\{describeUsage\(item\)\}/);
    expect(SETUP_UI).toMatch(/Not used anywhere/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('reactivation', () => {
  it('exists for all three master families', () => {
    expect(MASTER).toMatch(/router\.post\(`\/\$\{type\}\/:id\/reactivate`/);   // grades / bands
    expect(MASTER).toMatch(/router\.post\('\/:type\/:id\/reactivate'/);        // dept / desig / zones
    expect(MASTER).toMatch(/router\.post\('\/v\/:vocab\/:id\/reactivate'/);    // vocabularies
    expect(BRANCHES).toMatch(/router\.post\('\/:id\/reactivate'/);             // branches
  });

  it('re-checks for a name taken while the value was retired', () => {
    // The unique indexes are PARTIAL on is_active, so retiring a value frees
    // its name. Reactivating without this check is a 23505 from the UPDATE.
    expect(MASTER).toMatch(/const clash = await findDuplicateName\(table, rows\[0\]\.name/);
    expect(MASTER).toMatch(/const clash = await duplicateOf\(req, entry, row\.value, id\)/);
  });

  it('is admin-only', () => {
    const line = MASTER.match(/router\.post\('\/:type\/:id\/reactivate'[^\n]*/)[0];
    expect(line).toContain('allowRoles(...ADMIN_ROLES)');
    const branchLine = BRANCHES.match(/router\.post\('\/:id\/reactivate'[^\n]*/)[0];
    expect(branchLine).toContain('allowRoles(...ADMIN_ROLES)');
  });

  it('is reachable from the UI for masters and for branches', () => {
    expect(SETUP_UI).toMatch(/handleReactivate/);
    expect(SETUP_UI).toMatch(/Reactivate/);
    expect(BRANCH_UI).toMatch(/handleReactivate/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('duplicate protection is normalised AND at the database', () => {
  it('the migration creates a normalised index per master', () => {
    // ⚠ The index NAMES are built from a template literal (`ux_${t}_name_norm`),
    // so the expanded strings do not appear in the source. Assert the template
    // and the table lists it is expanded over — asserting the expansions here
    // would only prove this test can concatenate.
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ux_\$\{t\}_name_norm/);
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ux_\$\{t\}_company_name_norm/);
    expect(MIGRATION).toMatch(/const SHARED = \['master_departments', 'master_zones', 'master_designations'\]/);
    expect(MIGRATION).toMatch(/const SCOPED = \['master_grades', 'master_bands'\]/);
    expect(MIGRATION).toMatch(/LOWER\(BTRIM\(name\)\)/);
  });

  it('it preserves each table\'s existing tenancy', () => {
    // departments/designations/zones have no company_id; grades/bands do.
    // Widening or narrowing either would be a silent tenancy change.
    expect(MIGRATION).toMatch(/ON \$\{t\} \(LOWER\(BTRIM\(name\)\)\) WHERE is_active/);
    expect(MIGRATION).toMatch(/ON \$\{t\} \(COALESCE\(company_id, 0\), LOWER\(BTRIM\(name\)\)\) WHERE is_active/);
  });

  it('it collapses pre-existing variants BEFORE creating the index', () => {
    // The index cannot be created while variants exist, so a deployment that
    // has one would fail to boot without this.
    const dedupe = MIGRATION.indexOf('ROW_NUMBER() OVER');
    const create = MIGRATION.indexOf('CREATE UNIQUE INDEX');
    expect(dedupe).toBeGreaterThan(-1);
    expect(dedupe).toBeLessThan(create);
  });

  it('it deactivates the losers rather than deleting them', () => {
    // A variant employees still carry must keep rendering on their records.
    expect(MIGRATION).toMatch(/UPDATE \$\{t\} SET is_active = false/);
    expect(MIGRATION).not.toMatch(/DELETE FROM master_departments/);
  });

  it('the old exact-case constraints are dropped', () => {
    for (const c of ['master_departments_name_key', 'master_designations_name_key',
                     'master_zones_name_key']) {
      expect(MIGRATION, c).toContain(`DROP CONSTRAINT IF EXISTS ${c}`);
    }
  });

  it('the API compares the same way the index does', () => {
    expect(MASTER).toMatch(/LOWER\(BTRIM\(name\)\) = LOWER\(BTRIM\(\$1\)\)/);
    // …and still handles the 23505 it cannot pre-empt.
    expect((MASTER.match(/err\.code === '23505'/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('the refusal explains the normalisation rule', () => {
    expect(MASTER).toMatch(/ignoring case and spacing/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('usage declarations are real', () => {
  it('every org master declares at least one reference', () => {
    for (const key of ['departments', 'designations', 'zones', 'grades', 'bands']) {
      expect(USAGE[key], key).toBeTruthy();
      expect(USAGE[key].length, key).toBeGreaterThan(0);
    }
  });

  it('every reference names a table, a column and a human label', () => {
    for (const [key, refs] of Object.entries(USAGE)) {
      for (const r of refs) {
        expect(typeof r.table, key).toBe('string');
        expect(typeof r.column, key).toBe('string');
        expect(typeof r.label, key).toBe('string');
        // The label is printed as "8 <label>s", so a raw column name leaks.
        expect(r.label, `${key}.${r.table}`).not.toMatch(/_/);
      }
    }
  });

  it('vocabulary usage is derived from the registry, not a second list', () => {
    // vocabularies.js already declares `columns` for the audit report and the
    // seeding migration. A third copy here would be the thing that rots.
    expect(USAGE_SRC).toMatch(/import \{ BY_KEY \} from '\.\/vocabularies\.js'/);
    const banks = usageForVocab('banks');
    expect(banks.map(r => `${r.table}.${r.column}`)).toEqual(BY_KEY.banks.columns);
  });

  it('every registry vocabulary yields a usable reference list', () => {
    for (const v of REGISTRY) {
      const refs = usageForVocab(v.key);
      expect(Array.isArray(refs), v.key).toBe(true);
      for (const r of refs) expect(r.table && r.column, `${v.key} -> ${JSON.stringify(r)}`).toBeTruthy();
    }
  });

  it('counting is schema-safe: an absent table is skipped, not a 500', () => {
    // These declarations span modules a given deployment may not have migrated.
    expect(USAGE_SRC).toMatch(/const usable = refs\.filter\(r => cols\.has/);
  });

  it('counts are tenant-scoped and skip soft-deleted rows', () => {
    expect(USAGE_SRC).toMatch(/company_id = \$2/);
    expect(USAGE_SRC).toMatch(/deleted_at IS NULL/);
  });

  it('describeUsage reads as a sentence', () => {
    expect(describeUsage([{ label: 'employee', count: 8 }, { label: 'requisition', count: 1 }]))
      .toBe('8 employees, 1 requisition');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Branch stays an entity', () => {
  it('is not re-modelled as a vocabulary', () => {
    const keys = REGISTRY.map(v => v.key);
    for (const forbidden of ['locations', 'work-locations', 'branches', 'sites']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('Master Data Setup POINTS at the Branches screen rather than editing names', () => {
    expect(SETUP_UI).toMatch(/function BranchesPointer/);
    expect(SETUP_UI).toMatch(/BranchManagement/);
    // A SimpleListTab over /branches would offer a rename that drops the code,
    // address, type and contact details.
    expect(SETUP_UI).not.toMatch(/SimpleListTab endpoint="\/branches"/);
  });

  it('the Branches screen covers the full entity', () => {
    for (const field of ['code', 'city', 'state', 'address', 'phone', 'email', 'branch_type']) {
      expect(BRANCH_UI, field).toContain(field);
    }
    expect(BRANCH_UI).toMatch(/employee_count/);
  });

  it('every branch write is tenant-scoped', () => {
    // PUT and DELETE both had NO company predicate: an admin could rename or
    // deactivate another tenant's branch by id.
    const writes = BRANCHES.match(/UPDATE branches[\s\S]{0,700}?RETURNING/g) || [];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) expect(w, w.slice(0, 80)).toMatch(/scoped\.where/);
  });

  it('the scope helper takes an alias, because reads join and writes do not', () => {
    // Hard-coding `b.` produced "missing FROM-clause entry for table b" — a 500
    // on every branch write, which reads as a broken endpoint, not a scope bug.
    expect(BRANCHES).toMatch(/const scopeBranches = \(req, startAt, alias = 'b\.'\)/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('provenance', () => {
  it('the migration adds updated_at / created_by / updated_by', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS updated_at/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users\(id\)/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users\(id\)/);
  });

  it('created_by is a users.id, not an employees.id', () => {
    // `*_by` columns elsewhere in this schema point at employees; conflating
    // the two is a recurring bug here.
    expect(MASTER).toMatch(/const actorOf = \(req\) => req\.user\?\.userId \?\? req\.user\?\.id \?\? null/);
    expect(MIGRATION).toMatch(/REFERENCES users\(id\)/);
  });

  it('the down migration does NOT drop the columns', () => {
    // Dropping a column discards data irreversibly and cascade-drops indexes.
    expect(MIGRATION).toMatch(/deliberately NOT dropped/);
    expect(MIGRATION).not.toMatch(/DROP COLUMN/);
  });

  it('the list endpoints return it and the UI shows it', () => {
    expect(MASTER).toMatch(/cb\.name AS created_by_name/);
    expect(MASTER).toMatch(/ub\.name AS updated_by_name/);
    expect(SETUP_UI).toMatch(/const Meta = /);
    expect(SETUP_UI).toMatch(/Added \$\{created\}/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('workforce model', () => {
  it('seeds the departments a facilities/security workforce needs', () => {
    for (const d of ['Facilities', 'Security', 'Administration']) {
      expect(MIGRATION, d).toContain(`'${d}'`);
    }
  });

  it('seeds their designations', () => {
    for (const d of ['Housekeeping Staff', 'Security Guard', 'Driver', 'Office Assistant']) {
      expect(MIGRATION, d).toContain(`'${d}'`);
    }
  });

  it('does NOT invent a second workforce model', () => {
    // `contract_labour` already covers agency-supplied people.
    expect(MIGRATION).toMatch(/contract_labour/);
    expect(MIGRATION).toMatch(/does NOT create a second workforce model/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('"+ Add new" reaches the canonical master', () => {
  it('posts to the same endpoint the list is read from', () => {
    expect(SELECT_UI).toMatch(/await api\.post\(endpoint, payload\)/);
    // …and reloads from it, so the new value is a real master row, not a
    // client-side addition.
    expect(SELECT_UI).toMatch(/await load\(\);/);
  });

  it('auto-selects what it created', () => {
    expect(SELECT_UI).toMatch(/onChange\?\.\(next, row\)/);
  });

  it('offers a CLICKABLE route to where the value is managed', () => {
    // ⚠ STRENGTHENED 2026-09-29. Prose naming "Administration → Master Data"
    // named a destination with 24 tabs and left the user to find the right one.
    // It is a real control now that lands on the exact tab.
    expect(SELECT_UI).toMatch(/function ManageLink/);
    expect(SELECT_UI).toMatch(/import \{ masterAdminFor \} from '\.\/masterAdminLinks'/);
    // Rendered after a create AND at the foot of a menu that cannot create.
    expect(SELECT_UI).toMatch(/const createdNotice = created \?/);
    expect(SELECT_UI).toMatch(/data-master-manage-footer=/);
    // …and it still degrades to prose when the host passes no navigator.
    expect(SELECT_UI).toMatch(/DEGRADES TO PROSE/);
  });

  it('never puts Edit or Delete controls beside a dropdown option', () => {
    // ERP-wide changes do not belong behind a data-entry form. The picker
    // offers create-and-select; everything else is a link to the admin screen.
    const menuBlock = SELECT_UI.slice(SELECT_UI.indexOf('data-master-menu='), SELECT_UI.indexOf('document.body,'));
    for (const forbidden of [/onRename/, /handleRename/, /Deactivate/, /Retire/]) {
      expect(menuBlock, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('renders as a dialog BESIDE the picker, not instead of it', () => {
    expect(SELECT_UI).toMatch(/role="dialog"/);
    expect(SELECT_UI).toMatch(/aria-modal="true"/);
    // The old form was `if (adding) return <addRow/>`, which removed the field
    // from the form mid-edit.
    expect(SELECT_UI).not.toMatch(/if \(adding\) \{\s*\n\s*return \(/);
  });

  it('hides the option from anyone the backend would 403', () => {
    expect(SELECT_UI).toMatch(/const canAdd = allowAdd && hasAnyRole\(\.\.\.addRoles\)/);
  });
});
