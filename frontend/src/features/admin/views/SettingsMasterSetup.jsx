// ──────────────────────────────────────────────────────────────────────────────
// SettingsMasterSetup — the Settings door into the master-management screen.
//
// ⚠ Lives in `views/`, NOT `pages/`. autoRouter globs `features/**/pages/*.jsx`
// and turns every file it finds into an auto-discovered route; a composition
// like this one would land there as an orphan with no curated nav home, which
// `nav.structure.test.jsx` fails on. It is a routing wrapper, not a page.
//
// ⚠ SAME COMPONENT, DIFFERENT SCOPE. It renders `MasterSetup` with `exclude`
// set to the employee masters, which are managed from
// Employees → Manage Employee Masters. Each master therefore has exactly ONE
// place it is managed from, while there is still only ONE implementation —
// same tabs, same `/master/*` endpoints, same delete/deactivate rules.
//
// What stays here: the masters that belong to other modules — Units (UOM),
// HSN/SAC, and every non-HR vocabulary (industries, lead sources, project
// types, vendor categories, payment terms, travel and expense taxonomies).
// ──────────────────────────────────────────────────────────────────────────────
import MasterSetup, { EMPLOYEE_MASTER_TABS } from '../pages/MasterSetup';

export default function SettingsMasterSetup({ urlParams, setPage }) {
  return (
    <MasterSetup
      urlParams={urlParams}
      setPage={setPage}
      exclude={EMPLOYEE_MASTER_TABS}
      elsewhere={{
        label: 'Employee masters (departments, designations, grades, bands, zones, employment types, asset types, banks, qualifications and skill types)',
        page: 'EmployeeMasters',
        cta: 'Open Employee Masters',
      }}
    />
  );
}
