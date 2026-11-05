// ──────────────────────────────────────────────────────────────────────────────
// masterAdminLinks — "where do I edit this afterwards?", as data.
//
// WHY THIS EXISTS
// ---------------
// A picker that can CREATE a master value has to be able to say where that
// value is managed, and "Administration → Master Data" as plain prose is not
// an answer — it names a destination with 24 tabs and leaves the user to find
// the right one. This maps a picker's endpoint to the exact tab, so the link
// lands on Departments, not on the landing page.
//
// ⚠ ONE SOURCE. MasterSelect renders the link, the Add-new modal renders it,
// and `masterAdminLinks.test.jsx` checks every tab named here actually exists
// in MasterSetup. Three copies of this mapping is how a link starts pointing at
// a tab somebody renamed.
//
// ⚠ NOT EVERY MASTER IS A TAB. Branches are an ENTITY with their own screen
// (code, address, type, contact details, employee count), so the branch picker
// links to Settings → Company Setup → Branch Management instead. Calling it a vocabulary tab would
// be a lie, and a SimpleListTab over it would offer a rename that silently
// drops everything except the name.
// ──────────────────────────────────────────────────────────────────────────────

/** Master Data Setup's own tab keys. Vocabularies are keyed `v:<registry key>`. */
export const MASTER_ADMIN = {
  // ── Organisation masters (MasterSetup static tabs) ─────────────────────────
  '/master/departments':  { page: 'MasterSetup', tab: 'departments',  plural: 'Departments' },
  '/master/designations': { page: 'MasterSetup', tab: 'designations', plural: 'Designations' },
  '/master/zones':        { page: 'MasterSetup', tab: 'zones',        plural: 'Zones' },
  '/master/grades':       { page: 'MasterSetup', tab: 'grades',       plural: 'Grades' },
  '/master/bands':        { page: 'MasterSetup', tab: 'bands',        plural: 'Bands' },
  '/master/uom':          { page: 'MasterSetup', tab: 'uom',          plural: 'Units' },
  '/master/hsn':          { page: 'MasterSetup', tab: 'hsn',          plural: 'HSN / SAC codes' },

  // ── Entities with their own screen ─────────────────────────────────────────
  '/branches':            { page: 'BranchManagement', tab: null, plural: 'Locations',
                            where: 'Settings → Company Setup → Branch Management' },
};

/**
 * The sidebar group these screens live under.
 *
 * ⚠ "Settings", NOT "Administration". The pages' own heroes said
 * `eyebrow="Administration"` while the sidebar group has always been
 * **Settings**, so a link reading "Administration → Master Data" named a menu
 * that does not exist and sent the user hunting.
 *
 * ⚠ The group could NOT simply be renamed to match: NAV_ITEMS group names are
 * permission keys (see [[project_nav_information_architecture]]), so renaming
 * 'Settings' would silently re-key access control. The wording follows the nav,
 * not the other way round. `masterAdminLinks.test.jsx` derives the real group
 * from NAV_ITEMS and fails if these strings drift from it.
 */
export const ADMIN_GROUP = 'Settings';
export const MASTER_DATA_PATH = `${ADMIN_GROUP} → Master Data`;

/**
 * Where the EMPLOYEE masters are managed from HR's point of view.
 *
 * ⚠ The same screen as Settings → Master Data (EmployeeMasters renders
 * MasterSetup scoped with `only`), reached from All Employees. HR filling
 * in an employee should not be sent into an administrator's Settings menu to
 * fix a designation they just mistyped, so the "Manage X →" links point HERE.
 */
export const EMPLOYEE_MASTERS_PATH = 'Employees → All Employees → Manage Employee Masters';
const EMPLOYEE_MASTER_TABS = new Set([
  'departments', 'designations', 'zones', 'grades', 'bands',
  'v:employment-types', 'v:asset-types', 'v:banks',
  'v:qualifications', 'v:skill-types',
]);

/** An employee master routes to the Employees-area door; anything else to Settings. */
const destinationFor = (tab) => (EMPLOYEE_MASTER_TABS.has(tab)
  ? { page: 'EmployeeMasters', path: EMPLOYEE_MASTERS_PATH }
  : { page: 'MasterSetup',     path: MASTER_DATA_PATH });

/**
 * The management destination for a picker endpoint.
 *
 * Module vocabularies are `/master/v/<key>` (sometimes with a `?parent=` query
 * for a two-level taxonomy), and MasterSetup keys their tabs `v:<key>` — so
 * they resolve by rule rather than needing a row each. That is what keeps a
 * vocabulary added to `vocabularies.js` working here with no frontend edit,
 * the same property MasterSetup itself relies on.
 *
 * @param {string} endpoint  the picker's endpoint, e.g. '/master/v/banks'
 * @param {string} label     the picker's singular label, e.g. 'Bank'
 * @returns {{page:string, tab:string|null, plural:string, where:string}|null}
 */
export function masterAdminFor(endpoint, label) {
  if (!endpoint) return null;
  const clean = String(endpoint).split('?')[0];

  const known = MASTER_ADMIN[clean];
  if (known) {
    if (known.where) return { ...known };              // its own screen (branches)
    const dest = destinationFor(known.tab);
    return { ...known, page: dest.page, where: `${dest.path} → ${known.plural}` };
  }

  const vocab = clean.match(/^\/master\/v\/([^/]+)$/);
  if (vocab) {
    const plural = pluralise(label || vocab[1]);
    const tab = `v:${vocab[1]}`;
    const dest = destinationFor(tab);
    return { page: dest.page, tab, plural, where: `${dest.path} → ${plural}` };
  }
  return null;
}

/**
 * "Bank" → "Banks", "Qualification" → "Qualifications", "Asset Type" → "Asset
 * Types". Only ever applied to a registry label, which is always a singular
 * noun phrase — never to a value a user typed.
 */
function pluralise(word) {
  const w = String(word).trim();
  if (!w) return w;
  if (/[sxz]$/i.test(w) || /[cs]h$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

export { pluralise };
export default masterAdminFor;
