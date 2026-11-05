// ──────────────────────────────────────────────────────────────────────────────
// BranchSelect — the LOCATION picker, over the branch master.
//
// ── Why branches and not a new "locations" master ────────────────────────────
// `employees.location` was a free-text <input> on both employee forms. What it
// collected in company 1: 'Srivil', 'Srivi', 'czxzx'. Two truncated attempts at
// one place name and one piece of keyboard mash, on a field the HR register has
// a column for.
//
// The location master already existed and already had an FK from the employee
// record — `branches` (company-scoped, with name / code / city / state /
// branch_type and an admin CRUD screen) and `employees.branch_id`. That FK was
// NULL on all 46 live rows, because nothing had ever written it: the column and
// the table were built and then never connected to the form. So this is not a
// new master, it is the existing one finally wired to its own field.
//
// ⚠ Deliberately NOT `master_values`. A branch is a real entity with an address
// and a phone number that other modules join to, not an entry in a word list.
// Putting office names into the vocabulary table would have created the second
// source of truth that modules/master/vocabularies.js exists to prevent.
//
// ── What gets stored ─────────────────────────────────────────────────────────
// `branch_id` (canonical) and `location` (the branch's name, for the readers
// that already render a plain string — EmployeeProfile, the All Employees
// column, the export). The backend derives `location` from the branch it
// resolves rather than trusting the one posted, so the two cannot drift apart.
//
// ── No "+ Add new" ───────────────────────────────────────────────────────────
// Creating a branch means an address, a code, a type and a GST registration —
// it belongs on Administration ▸ Branches, not behind a "+" in a data-entry
// form. `allowAdd={false}`; MasterSelect then omits the option entirely rather
// than offering HR a button whose POST comes back 403.
// ──────────────────────────────────────────────────────────────────────────────
import MasterSelect from './MasterSelect';

/**
 * @param {number|string} value     the selected `branch_id` ('' when none)
 * @param {Function} onChange       (branchId, branchRow|null) => void — the row
 *                                  is passed through so the caller can store
 *                                  the display name alongside the id
 */
export default function BranchSelect({ value, onChange, ...rest }) {
  return (
    <MasterSelect
      endpoint="/branches"
      label="Location"
      // The id, not the name: `employees.branch_id` is the canonical column.
      optionValue="id"
      // City disambiguates two branches that share a name ("Head Office" in a
      // group with several registered entities), which is the whole reason the
      // register has a city column.
      optionLabel={(b) => (b.city ? `${b.name} — ${b.city}` : b.name)}
      // Always searchable. Left to MasterSelect's row-count threshold, a tenant
      // with two branches would get a native <select> and one with thirteen a
      // combobox — the same field behaving differently per tenant.
      searchable
      allowAdd={false}
      placeholder="Select location…"
      value={value ?? ''}
      onChange={onChange}
      {...rest}
    />
  );
}
